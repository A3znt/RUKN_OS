const { neon } = require('@neondatabase/serverless');
const statuses = ['new','confirmed','factory','manufacturing','ready','shipping','delivered','cancelled'];
const json=(status,obj)=>({statusCode:status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},body:JSON.stringify(obj)});
exports.handler=async(event)=>{
  if(!process.env.DATABASE_URL || !process.env.ROKN_ADMIN_TOKEN) return json(503,{error:'لم يتم إعداد DATABASE_URL و ROKN_ADMIN_TOKEN على السيرفر'});
  const supplied=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
  if(!supplied || supplied!==process.env.ROKN_ADMIN_TOKEN) return json(401,{error:'رمز الدخول غير صحيح'});
  const sql=neon(process.env.DATABASE_URL);
  const method=event.httpMethod;
  let data={}; try { data=event.body?JSON.parse(event.body):{}; } catch {return json(400,{error:'JSON غير صالح'});}
  try {
    if(method==='GET'){
      const [orders,inventory,workshops,drivers]=await Promise.all([
        sql`SELECT o.id,o.order_number,o.status,o.notes,o.delivery_fee,o.workshop_id,o.driver_id,o.created_at,c.name,c.phone,c.city,c.address,COALESCE(json_agg(json_build_object('id',i.id,'product',i.product_name,'color',i.color,'quantity',i.quantity,'price',i.unit_price,'notes',i.notes)) FILTER (WHERE i.id IS NOT NULL),'[]'::json) AS items FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id,c.id ORDER BY o.created_at DESC,o.id DESC`,
        sql`SELECT id,product_name,color,available,reserved,updated_at FROM inventory ORDER BY product_name,color`,
        sql`SELECT id,name,phone FROM workshops ORDER BY name`,
        sql`SELECT id,name,phone FROM drivers ORDER BY name`
      ]);
      return json(200,{orders,inventory,workshops,drivers});
    }
    if(method!=='POST') return json(405,{error:'طريقة غير مدعومة'});
    if(data.action==='order'){
      const name=String(data.name||'').trim(),phone=String(data.phone||'').trim(),city=String(data.city||'').trim(),address=String(data.address||'').trim();
      const items=Array.isArray(data.items)?data.items:[];
      if(!name||!items.length||items.length>30) return json(400,{error:'اسم الزبون والمنتجات مطلوبان'});
      for(const i of items)if(!String(i.product||'').trim()||!Number.isInteger(Number(i.quantity))||Number(i.quantity)<1||Number(i.quantity)>100) return json(400,{error:'راجع المنتجات والكميات'});
      const status=statuses.includes(data.status)?data.status:'new';
      const id=data.id?Number(data.id):null;
      let customerId;
      if(id){
        const existing=await sql`SELECT customer_id FROM orders WHERE id=${id}`;
        if(!existing.length)return json(404,{error:'الطلب غير موجود'});
        customerId=existing[0].customer_id;
        await sql`UPDATE customers SET name=${name},phone=${phone||null},city=${city||null},address=${address||null} WHERE id=${customerId}`;
        await sql`UPDATE orders SET status=${status},notes=${String(data.notes||'')},delivery_fee=${Number(data.delivery_fee)||0},workshop_id=${data.workshop_id?Number(data.workshop_id):null},driver_id=${data.driver_id?Number(data.driver_id):null},updated_at=now() WHERE id=${id}`;
        await sql`DELETE FROM order_items WHERE order_id=${id}`;
      }else{
        const customers=phone?await sql`SELECT id FROM customers WHERE phone=${phone} ORDER BY id LIMIT 1`:[];
        if(customers.length){customerId=customers[0].id;await sql`UPDATE customers SET name=${name},city=${city||null},address=${address||null} WHERE id=${customerId}`;}
        else {const rows=await sql`INSERT INTO customers(name,phone,city,address) VALUES(${name},${phone||null},${city||null},${address||null}) RETURNING id`;customerId=rows[0].id;}
        const orderNo='RK-'+Date.now()+'-'+Math.floor(Math.random()*1000);
        const rows=await sql`INSERT INTO orders(order_number,customer_id,status,notes,delivery_fee,workshop_id,driver_id) VALUES(${orderNo},${customerId},${status},${String(data.notes||'')},${Number(data.delivery_fee)||0},${data.workshop_id?Number(data.workshop_id):null},${data.driver_id?Number(data.driver_id):null}) RETURNING id`;data.id=rows[0].id;
      }
      for(const i of items)await sql`INSERT INTO order_items(order_id,product_name,color,quantity,unit_price,notes) VALUES(${data.id},${String(i.product).trim()},${String(i.color||'غير محدد')},${Number(i.quantity)},${Number(i.price)||0},${String(i.notes||'')})`;
      await sql`INSERT INTO order_events(order_id,event_type,new_value,actor) VALUES(${data.id},'order_saved',${JSON.stringify({status,items})}::jsonb,'rokn_os')`;
      return json(200,{ok:true,id:data.id});
    }
    if(data.action==='status'){
      const id=Number(data.id);if(!statuses.includes(data.status))return json(400,{error:'حالة غير صالحة'});
      const rows=await sql`UPDATE orders SET status=${data.status},updated_at=now() WHERE id=${id} RETURNING id`;
      if(!rows.length)return json(404,{error:'الطلب غير موجود'});
      await sql`INSERT INTO order_events(order_id,event_type,new_value,actor) VALUES(${id},'status_changed',${JSON.stringify({status:data.status})}::jsonb,'rokn_os')`;
      return json(200,{ok:true});
    }
    if(data.action==='stock'){
      const product=String(data.product||'').trim(),color=String(data.color||'').trim();
      const available=Number(data.available),reserved=Number(data.reserved||0);
      if(!product||!color||!Number.isInteger(available)||available<0||!Number.isInteger(reserved)||reserved<0||reserved>available)return json(400,{error:'بيانات المخزون غير صحيحة: المحجوز لا يتجاوز الإجمالي'});
      const found=await sql`SELECT id FROM inventory WHERE product_name=${product} AND color=${color} LIMIT 1`;
      if(found.length)await sql`UPDATE inventory SET available=${available},reserved=${reserved},updated_at=now() WHERE id=${found[0].id}`;
      else await sql`INSERT INTO inventory(product_name,color,available,reserved) VALUES(${product},${color},${available},${reserved})`;
      return json(200,{ok:true});
    }
    if(data.action==='contact'){
      const kind=data.kind==='driver'?'driver':'workshop',name=String(data.name||'').trim(),phone=String(data.phone||'').trim();
      if(!name)return json(400,{error:'الاسم مطلوب'});
      if(kind==='driver')await sql`INSERT INTO drivers(name,phone) VALUES(${name},${phone})`;
      else await sql`INSERT INTO workshops(name,phone) VALUES(${name},${phone})`;
      return json(200,{ok:true});
    }
    return json(400,{error:'عملية غير معروفة'});
  }catch(err){console.error('ROKN API error',err);return json(500,{error:'تعذّر تنفيذ العملية على قاعدة البيانات'});}
};