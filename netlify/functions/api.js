const { Pool, neonConfig } = require('@neondatabase/serverless');
const { timingSafeEqual, randomUUID } = require('node:crypto');
neonConfig.webSocketConstructor = require('ws');
const STATUS=['new','confirmed','factory','manufacturing','ready','delivery','delivered','cancelled'];
const NEXT={new:['confirmed','cancelled'],confirmed:['factory','ready','cancelled'],factory:['manufacturing','cancelled'],manufacturing:['ready','cancelled'],ready:['delivery','cancelled'],delivery:['delivered','ready'],delivered:[],cancelled:[]};
const reply=(status,obj)=>({statusCode:status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},body:JSON.stringify(obj)});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
const number=(v,label,max=1000000)=>{const n=Number(v);if(!Number.isFinite(n)||n<0||n>max)fail('راجع '+label);return n};
const integer=(v,label,min=0)=>{const n=number(v,label);if(!Number.isInteger(n)||n<min)fail('راجع '+label);return n};
const date=v=>{if(!v)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v)))fail('تاريخ غير صالح');return v};
async function snapshot(q){const results=await Promise.all([
 q(`SELECT o.*,c.name,c.phone,c.city,c.address,COALESCE((SELECT json_agg(json_build_object('product',i.product_name,'color',i.color,'quantity',i.quantity,'price',i.unit_price,'notes',i.notes,'stock_color',i.stock_color) ORDER BY i.id) FROM order_items i WHERE i.order_id=o.id),'[]') items,COALESCE((SELECT sum(amount) FROM payments WHERE order_id=o.id),0) paid,COALESCE((SELECT sum(amount) FROM payments WHERE order_id=o.id AND method='driver_cash'),0) driver_collected FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC,o.id DESC`),
 q('SELECT * FROM inventory ORDER BY product_name,color'),q('SELECT * FROM workshops ORDER BY name'),q('SELECT * FROM drivers ORDER BY name'),q('SELECT * FROM products WHERE active=true ORDER BY name,variant'),q('SELECT * FROM production_batches ORDER BY id DESC'),q('SELECT * FROM order_events ORDER BY id DESC LIMIT 100')]);
 return Object.fromEntries(['orders','inventory','workshops','drivers','products','batches','events'].map((k,i)=>[k,results[i].rows]));}
async function event(q,id,type,value,old=null){await q('INSERT INTO order_events(order_id,event_type,new_value,old_value,actor) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[id,type,JSON.stringify(value),JSON.stringify(old),'rokn_os']);}
async function order(q,id,revision){const r=(await q('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)fail('الطلب غير موجود',404);if(revision!==undefined&&Number(revision)!==r.revision)fail('تغيّر الطلب من جهاز آخر. حدّث البيانات وأعد المحاولة.',409);return r;}
async function release(q,o,consume=false){for(const a of o.stock_allocations||[]){const r=await q('UPDATE inventory SET reserved=reserved-$1,available=available-$2,updated_at=now() WHERE id=$3 AND reserved >= $1 AND available >= $2 RETURNING id',[a.qty,consume?a.qty:0,a.id]);if(!r.rowCount)fail('المخزون المحجوز غير متطابق؛ راجع الجرد',409);}await q("UPDATE orders SET stock_allocations='[]' WHERE id=$1",[o.id]);}
async function reserve(q,id,required=false){const lines=(await q('SELECT product_name,COALESCE(stock_color,color) color,sum(quantity)::int qty FROM order_items WHERE order_id=$1 GROUP BY product_name,COALESCE(stock_color,color)',[id])).rows;const allocations=[];for(const i of lines){const rows=(await q('SELECT * FROM inventory WHERE product_name=$1 AND color=$2 ORDER BY id FOR UPDATE',[i.product_name,i.color])).rows;if(rows.length!==1||rows[0].available-rows[0].reserved<i.qty){if(required)fail('الكمية غير جاهزة: '+i.product_name+' · '+i.color+'؛ سجّل استلام التصنيع أو حدّث الجرد أولًا');return false;}allocations.push({id:rows[0].id,qty:i.qty});}for(const a of allocations)await q('UPDATE inventory SET reserved=reserved+$1,updated_at=now() WHERE id=$2',[a.qty,a.id]);await q('UPDATE orders SET stock_allocations=$1::jsonb WHERE id=$2',[JSON.stringify(allocations),id]);return true;}
async function mutate(q,d){
 if(d.action==='order'){
  const name=text(d.name,120),phone=text(d.phone,30),city=text(d.city,100),address=text(d.address,400);
  if(!name||!phone||!city||!address)fail('الاسم والهاتف والمدينة والعنوان مطلوبون');
  if(!/^[+\d ()-]{7,20}$/.test(phone))fail('راجع رقم الهاتف');
  if(!Array.isArray(d.items)||!d.items.length||d.items.length>30)fail('أضف من 1 إلى 30 صنفًا');
  const items=[];for(const i of d.items){const product=text(i.product,120),color=text(i.color,120);if(!product||!color)fail('المنتج واللون مطلوبان');const p=(await q('SELECT * FROM products WHERE name=$1 AND variant=$2 AND active=true ORDER BY id LIMIT 1',[product,color])).rows[0];items.push({product,color,quantity:integer(i.quantity,'الكمية',1),price:number(i.price,'السعر'),notes:text(i.notes),stock_color:p?.stock_variant||color});}
  const fee=number(d.delivery_fee||0,'التوصيل');let old=null,id=d.id?integer(d.id,'رقم الطلب',1):null;
  if(!id&&d.request_id){const seen=(await q('SELECT id FROM orders WHERE request_id=$1',[text(d.request_id,100)])).rows[0];if(seen)return {ok:true,id:seen.id,duplicate:true};}
  if(id){old=await order(q,id,d.revision);if(['delivery','delivered','cancelled'].includes(old.status))fail('لا يمكن تعديل طلب خرج للتوصيل أو أُغلق');await release(q,old);}
  // Each order owns a customer snapshot: editing an address must not rewrite earlier orders.
  const cid=(await q('INSERT INTO customers(name,phone,city,address) VALUES($1,$2,$3,$4) RETURNING id',[name,phone,city,address])).rows[0].id;
  const args=[cid,text(d.notes,2000),fee,d.workshop_id?integer(d.workshop_id,'الورشة',1):null,d.driver_id?integer(d.driver_id,'السائق',1):null,date(d.estimated_delivery_to)];
  if(id){await q('UPDATE orders SET customer_id=$1,notes=$2,delivery_fee=$3,workshop_id=$4,driver_id=$5,estimated_delivery_to=$6,revision=revision+1,updated_at=now() WHERE id=$7',[...args,id]);await q('DELETE FROM order_items WHERE order_id=$1',[id]);}
  else id=(await q("INSERT INTO orders(customer_id,notes,delivery_fee,workshop_id,driver_id,estimated_delivery_to,order_number,status,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,'new',$8) RETURNING id",[...args,'RK-'+randomUUID().slice(0,8).toUpperCase(),text(d.request_id,100)||randomUUID()])).rows[0].id;
  for(const i of items)await q('INSERT INTO order_items(order_id,product_name,color,quantity,unit_price,notes,stock_color) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,i.product,i.color,i.quantity,i.price,i.notes,i.stock_color]);
  const paid=Number((await q('SELECT COALESCE(sum(amount),0) n FROM payments WHERE order_id=$1',[id])).rows[0].n);if(paid>fee+items.reduce((s,i)=>s+i.quantity*i.price,0))fail('الإجمالي أقل من المدفوع؛ راجع الدفعات قبل التعديل');
  if(old&&old.status!=='new')await reserve(q,id,old.status==='ready');
  await event(q,id,'order_saved',{items,name},old?{status:old.status,revision:old.revision}:null);return {ok:true,id};
 }
 if(d.action==='status'){
  const o=await order(q,integer(d.id,'الطلب',1),d.revision);if(!NEXT[o.status]?.includes(d.status))fail('هذه الخطوة غير متاحة من حالة الطلب الحالية');
  if(['factory','manufacturing'].includes(d.status)&&!o.workshop_id)fail('حدد الورشة من تعديل الطلب أولًا');
  if(d.status==='confirmed'&&!o.stock_allocations.length)await reserve(q,o.id);
  if(d.status==='ready'&&!o.stock_allocations.length)await reserve(q,o.id,true);
  if(d.status==='delivery'&&(!o.driver_id||!o.estimated_delivery_to||!o.stock_allocations.length))fail('حدد السائق وموعد التوصيل واحجز المخزون أولًا');
  if(d.status==='delivered'){if(!o.stock_allocations.length)fail('راجع حجز المخزون أولًا');await release(q,o,true);}
  if(d.status==='cancelled'){const paid=Number((await q('SELECT COALESCE(sum(amount),0) n FROM payments WHERE order_id=$1',[o.id])).rows[0].n);if(paid>0)fail('الطلب فيه دفعات؛ سوِّ المبلغ قبل الإلغاء');await release(q,o);}
  if(o.status==='delivery'&&d.status==='ready'&&!text(d.reason))fail('اكتب سبب تعذّر التسليم');
  await q("UPDATE orders SET status=$1,revision=revision+1,updated_at=now(),handed_to_courier_on=CASE WHEN $1='delivery' THEN CURRENT_DATE ELSE handed_to_courier_on END WHERE id=$2",[d.status,o.id]);await event(q,o.id,'status_changed',{status:d.status,reason:text(d.reason)},{status:o.status});return {ok:true};
 }
 if(d.action==='stock'){
  const product=text(d.product,120),color=text(d.color,120),total=integer(d.available,'الموجود');if(!product||!color)fail('المنتج واللون مطلوبان');
  const found=(await q('SELECT * FROM inventory WHERE product_name=$1 AND color=$2 FOR UPDATE',[product,color])).rows;
  if(found.length>1)fail('هناك سجلات مخزون مكررة؛ راجعها قبل التعديل');
  if(found[0]){if(total<found[0].reserved)fail('الموجود أقل من المحجوز');await q('UPDATE inventory SET available=$1,updated_at=now() WHERE id=$2',[total,found[0].id]);}else await q('INSERT INTO inventory(product_name,color,available,reserved) VALUES($1,$2,$3,0)',[product,color,total]);return {ok:true};
 }
 if(d.action==='product'){
  const name=text(d.name,120),variant=text(d.variant,120),photo=text(d.photo_url,1000);if(!name||!variant)fail('الاسم والنسخة مطلوبان');if(photo&&!/^https:\/\//.test(photo)&&!/^\/products\/[a-z0-9.-]+$/i.test(photo))fail('رابط الصورة غير صالح');
  const args=[name,variant,d.price===''||d.price==null?null:number(d.price,'السعر'),photo||null,text(d.size,150),text(d.description,500),text(d.stock_variant,120)||variant,d.lead_days===''||d.lead_days==null?null:integer(d.lead_days,'أيام التجهيز')];
  const existing=(await q('SELECT id FROM products WHERE name=$1 AND variant=$2',[name,variant])).rows[0];
  if(existing)await q('UPDATE products SET name=$1,variant=$2,price=$3,photo_url=$4,size=$5,description=$6,stock_variant=$7,lead_days=$8,active=true WHERE id=$9',[...args,existing.id]);else await q('INSERT INTO products(name,variant,price,photo_url,size,description,stock_variant,lead_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',args);return {ok:true};
 }
 if(d.action==='contact'){const name=text(d.name,120);if(!name)fail('الاسم مطلوب');await q(d.kind==='driver'?'INSERT INTO drivers(name,phone) VALUES($1,$2)':'INSERT INTO workshops(name,phone) VALUES($1,$2)',[name,text(d.phone,30)]);return {ok:true};}
 if(d.action==='batch'){
  if(!text(d.product)||!text(d.color))fail('حدد المنتج واللون');await q('INSERT INTO production_batches(workshop_id,product_name,color,quantity,estimated_days,notes) VALUES($1,$2,$3,$4,$5,$6)',[integer(d.workshop_id,'الورشة',1),text(d.product,120),text(d.color,120),integer(d.quantity,'الكمية',1),integer(d.estimated_days,'أيام التجهيز',1),text(d.notes)]);return {ok:true};
 }
 if(d.action==='receive'){
  const b=(await q('SELECT * FROM production_batches WHERE id=$1 FOR UPDATE',[integer(d.id,'الدفعة',1)])).rows[0];if(!b)fail('الدفعة غير موجودة');const qty=integer(d.quantity,'المستلم',1);if(qty>b.quantity-b.received)fail('المستلم أكبر من المتبقي');const inv=(await q('SELECT id FROM inventory WHERE product_name=$1 AND color=$2',[b.product_name,b.color])).rows;if(inv.length>1)fail('راجع تكرار الجرد');if(inv[0])await q('UPDATE inventory SET available=available+$1,updated_at=now() WHERE id=$2',[qty,inv[0].id]);else await q('INSERT INTO inventory(product_name,color,available,reserved) VALUES($1,$2,$3,0)',[b.product_name,b.color,qty]);await q('UPDATE production_batches SET received=received+$1 WHERE id=$2',[qty,b.id]);return {ok:true};
 }
 if(d.action==='payment'){
  const o=await order(q,integer(d.id,'الطلب',1),d.revision);if(o.status==='cancelled')fail('الطلب ملغي');const amount=number(d.amount,'المبلغ');if(!amount)fail('أدخل مبلغًا أكبر من صفر');if(!['cash','transfer','driver_cash'].includes(d.method))fail('طريقة دفع غير صالحة');if(d.method==='driver_cash'&&!o.driver_id)fail('حدد السائق أولًا');const sum=(await q('SELECT COALESCE((SELECT sum(quantity*unit_price) FROM order_items WHERE order_id=$1),0) total,COALESCE((SELECT sum(amount) FROM payments WHERE order_id=$1),0) paid',[o.id])).rows[0];if(amount>Number(sum.total)+Number(o.delivery_fee)-Number(sum.paid)+.001)fail('المبلغ أكبر من الباقي');await q('INSERT INTO payments(order_id,amount,method) VALUES($1,$2,$3)',[o.id,amount,d.method]);await q('UPDATE orders SET revision=revision+1,updated_at=now() WHERE id=$1',[o.id]);await event(q,o.id,'payment',{amount,method:d.method});return {ok:true};
 }
 if(d.action==='settle'){
  const o=await order(q,integer(d.id,'الطلب',1),d.revision),amount=number(d.amount,'التسوية');const collected=Number((await q("SELECT COALESCE(sum(amount),0) n FROM payments WHERE order_id=$1 AND method='driver_cash'",[o.id])).rows[0].n);if(!amount||amount>collected-Number(o.settled_amount))fail('راجع المبلغ الموجود عند السائق');await q('UPDATE orders SET settled_amount=settled_amount+$1,revision=revision+1,updated_at=now() WHERE id=$2',[amount,o.id]);await event(q,o.id,'settlement',{amount});return {ok:true};
 }
 fail('عملية غير معروفة');
}
exports.handler=async event=>{
 if(!process.env.DATABASE_URL||!process.env.ROKN_ADMIN_TOKEN)return reply(503,{error:'الاتصال غير جاهز'});
 const supplied=(event.headers?.authorization||event.headers?.Authorization||'').replace(/^Bearer\s+/i,'');const a=Buffer.from(supplied),b=Buffer.from(process.env.ROKN_ADMIN_TOKEN);if(a.length!==b.length||!timingSafeEqual(a,b))return reply(401,{error:'رمز الدخول غير صحيح'});
 if(!['GET','POST'].includes(event.httpMethod))return reply(405,{error:'طريقة غير مدعومة'});
 let d={};try{if((event.body||'').length>250000)fail('الطلب كبير جدًا');d=JSON.parse(event.body||'{}');}catch(e){return reply(400,{error:e.status?e.message:'بيانات غير صالحة'});}
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});let client;
 try{client=await pool.connect();const q=(s,p)=>client.query(s,p);if(event.httpMethod==='GET')return reply(200,await snapshot(q));await q('BEGIN');await q("SET LOCAL lock_timeout='5s'");await q('SELECT pg_advisory_xact_lock(726567)');const result=await mutate(q,d);await q('COMMIT');return reply(200,result);}catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});console.error('ROKN API',e.code||e.status||'error');return reply(e.status||500,{error:e.status?e.message:'تعذّر الحفظ. لم تُطبّق تغييرات جزئية؛ حدّث البيانات وحاول مجددًا.'});}finally{client?.release();await pool.end();}
};
exports._test={mutate,NEXT};
