CREATE TABLE customers(id bigserial PRIMARY KEY,name text,phone text,city text,address text,created_at timestamptz DEFAULT now());
CREATE TABLE workshops(id bigserial PRIMARY KEY,name text,phone text,notes text);
CREATE TABLE drivers(id bigserial PRIMARY KEY,name text,phone text);
CREATE TABLE products(id bigserial PRIMARY KEY,name text,variant text,photo_url text,active boolean DEFAULT true,created_at timestamptz DEFAULT now());
CREATE TABLE inventory(id bigserial PRIMARY KEY,product_id bigint,product_name text,color text,available int DEFAULT 0,reserved int DEFAULT 0,updated_at timestamptz DEFAULT now());
CREATE TABLE orders(id bigserial PRIMARY KEY,order_number text,customer_id bigint REFERENCES customers(id),status text DEFAULT 'new',workshop_id bigint REFERENCES workshops(id),driver_id bigint REFERENCES drivers(id),delivery_fee numeric DEFAULT 0,notes text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),handed_to_courier_on date,estimated_delivery_from date,estimated_delivery_to date,delivery_company text);
CREATE TABLE order_items(id bigserial PRIMARY KEY,order_id bigint REFERENCES orders(id),product_id bigint,product_name text,color text,quantity int DEFAULT 1,unit_price numeric,notes text);
CREATE TABLE order_events(id bigserial PRIMARY KEY,order_id bigint REFERENCES orders(id),event_type text,old_value jsonb,new_value jsonb,actor text,created_at timestamptz DEFAULT now());
CREATE TABLE payments(id bigserial PRIMARY KEY,order_id bigint REFERENCES orders(id),amount numeric,method text,received_at timestamptz DEFAULT now());
CREATE TABLE production_batches(id bigserial PRIMARY KEY,workshop_id bigint REFERENCES workshops(id),product_name text,color text,quantity int,received int DEFAULT 0,started_on date DEFAULT CURRENT_DATE,estimated_days int,notes text DEFAULT '',created_at timestamptz DEFAULT now());

ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN ('new','confirmed','factory','manufacturing','ready','delivery','delivered','cancelled'));
ALTER TABLE inventory ADD UNIQUE(product_name,color);
ALTER TABLE production_batches ADD CHECK(estimated_days BETWEEN 1 AND 365);
