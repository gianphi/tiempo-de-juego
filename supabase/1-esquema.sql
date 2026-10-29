-- =====================================================================
--  Organizador de tiempo — base de datos y seguridad
--  Pegar COMPLETO en Supabase → SQL Editor → New query → Run.
--  Se puede volver a ejecutar sin perder datos.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- La versión anterior usaba usuarios con correo; ya no hace falta.
drop table if exists public.perfiles cascade;

-- ---------- Acceso con PIN ----------

-- PIN de cada rol, cifrado. Nadie lo puede leer desde la app.
create table if not exists public.pines (
  rol      text primary key check (rol in ('admin', 'tutora')),
  pin_hash text not null
);

-- Cada dispositivo que entró con un PIN correcto (usuario anónimo de Supabase).
create table if not exists public.sesiones (
  uid       uuid primary key references auth.users(id) on delete cascade,
  rol       text not null check (rol in ('admin', 'tutora')),
  activa    boolean not null default true,
  creado_en timestamptz not null default now()
);

-- ---------- Tablas ----------

-- Minutos que gana si completa TODAS las tareas del día (admin y tutora los cambian).
create table if not exists public.ajustes (
  id      int primary key default 1 check (id = 1),
  minutos int not null default 60 check (minutos between 0 and 600)
);
insert into public.ajustes (id) values (1) on conflict (id) do nothing;

-- Tareas del checklist diario.
create table if not exists public.tareas (
  id        uuid primary key default gen_random_uuid(),
  titulo    text not null check (length(trim(titulo)) between 1 and 120),
  activa    boolean not null default true,
  creado_en timestamptz not null default now()
);

-- Una fila = una tarea marcada como hecha en una fecha.
create table if not exists public.marcas (
  fecha     date not null,
  tarea_id  uuid not null references public.tareas(id) on delete cascade,
  hecha_por uuid references auth.users(id) default auth.uid(),
  hecha_en  timestamptz not null default now(),
  primary key (fecha, tarea_id)
);

-- Foto de cada día para el historial.
create table if not exists public.resumen_dia (
  fecha           date primary key,
  total           int not null,
  hechas          int not null,
  minutos_ganados int not null,
  actualizado_en  timestamptz not null default now()
);

-- Solicitudes de tiempo de juego.
create table if not exists public.solicitudes (
  id           uuid primary key default gen_random_uuid(),
  fecha        date not null,
  hora         time,
  minutos      int not null check (minutos between 5 and 600),
  pedido_por   text not null check (pedido_por in ('cristian', 'tutora', 'admin')),
  nota         text check (length(nota) <= 500),
  estado       text not null default 'pendiente'
               check (estado in ('pendiente', 'aprobada', 'rechazada')),
  creado_por   uuid references auth.users(id) default auth.uid(),
  creado_en    timestamptz not null default now(),
  decidido_por uuid references auth.users(id),
  decidido_en  timestamptz,
  iniciada_en  timestamptz,
  terminada_en timestamptz
);

-- Chat tutora ↔ admin. No se puede editar ni borrar desde la app.
create table if not exists public.mensajes (
  id           bigint generated always as identity primary key,
  autor        uuid not null references auth.users(id) default auth.uid(),
  tipo         text not null default 'texto'
               check (tipo in ('texto', 'solicitud', 'decision', 'sesion')),
  texto        text not null default '' check (length(texto) <= 2000),
  solicitud_id uuid references public.solicitudes(id) on delete set null,
  creado_en    timestamptz not null default now()
);

-- Registro automático de cambios. Solo el admin lo puede leer.
create table if not exists public.actividad (
  id      bigint generated always as identity primary key,
  en      timestamptz not null default now(),
  usuario uuid,
  tabla   text not null,
  accion  text not null,
  antes   jsonb,
  despues jsonb
);

create index if not exists solicitudes_fecha_idx on public.solicitudes (fecha);

-- ---------- Rol del usuario actual ----------

create or replace function public.mi_rol()
returns text
language sql stable security definer
set search_path = public
as $$ select rol from public.sesiones where uid = auth.uid() and activa $$;

-- Verifica el PIN en el servidor. Tras 15 PIN incorrectos, bloquea 30 minutos.
create or replace function public.entrar_con_pin(p_pin text)
returns text
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_rol text;
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  if (select count(*) from public.actividad
      where tabla = 'acceso' and accion = 'FALLO' and en > now() - interval '30 minutes') >= 15 then
    raise exception 'Demasiados PIN incorrectos. Espera 30 minutos.';
  end if;
  select rol into v_rol from public.pines where pin_hash = crypt(coalesce(p_pin, ''), pin_hash);
  insert into public.actividad (usuario, tabla, accion, despues)
  values (auth.uid(), 'acceso', case when v_rol is null then 'FALLO' else 'ENTRO' end,
          case when v_rol is null then null else jsonb_build_object('rol', v_rol) end);
  if v_rol is not null then
    insert into public.sesiones (uid, rol) values (auth.uid(), v_rol)
    on conflict (uid) do update set rol = excluded.rol, activa = true;
  end if;
  return v_rol;
end $$;

create or replace function public.salir_de_sesion()
returns void
language sql security definer
set search_path = public
as $$ update public.sesiones set activa = false where uid = auth.uid(); $$;

revoke execute on function public.entrar_con_pin(text) from public, anon;
revoke execute on function public.salir_de_sesion()    from public, anon;
grant  execute on function public.entrar_con_pin(text) to authenticated;
grant  execute on function public.salir_de_sesion()    to authenticated;

-- ---------- Seguridad por filas (RLS) ----------
-- Quien no entró con un PIN correcto (por ejemplo, alguien con la clave
-- pública) no ve ni modifica NADA.

alter table public.pines       enable row level security;
alter table public.sesiones    enable row level security;
alter table public.ajustes     enable row level security;
alter table public.tareas      enable row level security;
alter table public.marcas      enable row level security;
alter table public.resumen_dia enable row level security;
alter table public.solicitudes enable row level security;
alter table public.mensajes    enable row level security;
alter table public.actividad   enable row level security;

-- pines: sin políticas → nadie lo lee ni lo cambia desde la app.

-- sesiones: solo lectura (para saber quién escribió cada cosa).
drop policy if exists "leer sesiones" on public.sesiones;
create policy "leer sesiones" on public.sesiones
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists "leer ajustes" on public.ajustes;
create policy "leer ajustes" on public.ajustes
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists "cambiar ajustes" on public.ajustes;
create policy "cambiar ajustes" on public.ajustes
  for update to authenticated
  using (public.mi_rol() is not null) with check (public.mi_rol() is not null);

drop policy if exists "gestionar tareas" on public.tareas;
create policy "gestionar tareas" on public.tareas
  for all to authenticated
  using (public.mi_rol() is not null) with check (public.mi_rol() is not null);

drop policy if exists "gestionar marcas" on public.marcas;
create policy "gestionar marcas" on public.marcas
  for all to authenticated
  using (public.mi_rol() is not null)
  with check (public.mi_rol() is not null and hecha_por = auth.uid());

drop policy if exists "gestionar resumen" on public.resumen_dia;
create policy "gestionar resumen" on public.resumen_dia
  for all to authenticated
  using (public.mi_rol() is not null) with check (public.mi_rol() is not null);

drop policy if exists "leer solicitudes" on public.solicitudes;
create policy "leer solicitudes" on public.solicitudes
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists "crear solicitudes" on public.solicitudes;
create policy "crear solicitudes" on public.solicitudes
  for insert to authenticated
  with check (public.mi_rol() is not null and creado_por = auth.uid());

drop policy if exists "decidir solicitudes" on public.solicitudes;
create policy "decidir solicitudes" on public.solicitudes
  for update to authenticated
  using (public.mi_rol() is not null) with check (public.mi_rol() is not null);

drop policy if exists "leer mensajes" on public.mensajes;
create policy "leer mensajes" on public.mensajes
  for select to authenticated using (public.mi_rol() is not null);

drop policy if exists "escribir mensajes" on public.mensajes;
create policy "escribir mensajes" on public.mensajes
  for insert to authenticated
  with check (public.mi_rol() is not null and autor = auth.uid());

drop policy if exists "solo admin lee actividad" on public.actividad;
create policy "solo admin lee actividad" on public.actividad
  for select to authenticated using (public.mi_rol() = 'admin');

-- ---------- Registro de actividad ----------

create or replace function public.registrar_actividad()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.actividad (usuario, tabla, accion, antes, despues)
  values (
    auth.uid(), tg_table_name, tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

drop trigger if exists actividad_tareas on public.tareas;
create trigger actividad_tareas after insert or update or delete on public.tareas
  for each row execute function public.registrar_actividad();

drop trigger if exists actividad_marcas on public.marcas;
create trigger actividad_marcas after insert or delete on public.marcas
  for each row execute function public.registrar_actividad();

drop trigger if exists actividad_solicitudes on public.solicitudes;
create trigger actividad_solicitudes after insert or update on public.solicitudes
  for each row execute function public.registrar_actividad();

drop trigger if exists actividad_ajustes on public.ajustes;
create trigger actividad_ajustes after update on public.ajustes
  for each row execute function public.registrar_actividad();

-- Quién decidió y cuándo lo pone el servidor, no el celular.
create or replace function public.fijar_decision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.estado is distinct from old.estado then
    new.decidido_por := auth.uid();
    new.decidido_en  := now();
  end if;
  return new;
end $$;

drop trigger if exists solicitudes_decision on public.solicitudes;
create trigger solicitudes_decision before update on public.solicitudes
  for each row execute function public.fijar_decision();

-- ---------- Temporizador (usa la hora del servidor) ----------
-- Devuelven true solo para quien hizo el cambio (evita avisos repetidos).

create or replace function public.iniciar_juego(p_id uuid)
returns boolean
language sql security invoker
set search_path = public
as $$
  with u as (
    update public.solicitudes set iniciada_en = now()
    where id = p_id and estado = 'aprobada' and iniciada_en is null
    returning 1
  )
  select exists (select 1 from u);
$$;

create or replace function public.terminar_juego(p_id uuid)
returns boolean
language sql security invoker
set search_path = public
as $$
  with u as (
    update public.solicitudes
    set terminada_en = least(now(), iniciada_en + make_interval(mins => minutos))
    where id = p_id and iniciada_en is not null and terminada_en is null
    returning 1
  )
  select exists (select 1 from u);
$$;

revoke execute on function public.iniciar_juego(uuid)  from public, anon;
revoke execute on function public.terminar_juego(uuid) from public, anon;
grant  execute on function public.iniciar_juego(uuid)  to authenticated;
grant  execute on function public.terminar_juego(uuid) to authenticated;

-- ---------- Entrar sin contraseña (solo ver citas) ----------
-- Cualquiera con el enlace puede llamarla. Devuelve solo las citas APROBADAS
-- desde hoy (fecha, hora, minutos y temporizador): sin notas, nombres ni chat.

create or replace function public.citas_aprobadas(p_desde date)
returns table (id uuid, fecha date, hora time, minutos int, iniciada_en timestamptz, terminada_en timestamptz)
language sql stable security definer
set search_path = public
as $$
  select s.id, s.fecha, s.hora, s.minutos, s.iniciada_en, s.terminada_en
  from public.solicitudes s
  where s.estado = 'aprobada' and s.fecha >= greatest(p_desde, current_date - 2)
  order by s.fecha, s.hora nulls last, s.creado_en
  limit 50
$$;

revoke execute on function public.citas_aprobadas(date) from public;
grant  execute on function public.citas_aprobadas(date) to anon, authenticated;

-- ---------- Tiempo real (chat y checklist sincronizados) ----------

do $$
declare t text;
begin
  foreach t in array array['ajustes', 'tareas', 'marcas', 'solicitudes', 'mensajes'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- Tareas de ejemplo (solo si no hay ninguna) ----------

insert into public.tareas (titulo)
select * from (values ('Tareas del colegio'), ('Ordenar su cuarto'), ('Leer 20 minutos')) as v(titulo)
where not exists (select 1 from public.tareas);
