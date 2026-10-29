# 🎮 Organizador de tiempo

App web para controlar el tiempo de juego de Cristian con un checklist diario.
Funciona en celular, tablet y PC, sincronizada en línea, gratis.

- **Solo PIN:** al abrir se escribe el PIN y el PIN decide quién entra (Admin o Tutora). No hay cuentas ni correos.
- **Hoy:** checklist del día. *Todo o nada*: si Cristian completa **todas** las tareas, gana el tiempo fijado; si falta una, 0.
  Admin y tutora pueden marcar y editar las tareas, y cambiar el tiempo a ganar.
- **Chat** (tutora ↔ admin): solicitudes de juego (las pide Cristian o la tutora), aprobar / cambiar / rechazar, y temporizador.
- **Control** (solo admin): últimos 7 días y registro de todo lo que hace cada uno.
- **Entrar sin contraseña:** en la pantalla de inicio. Solo muestra las citas aprobadas
  (fecha, hora, minutos y cuenta regresiva); sin tareas, chat, notas ni nombres. Se actualiza cada 30 segundos.

Prueba sin configurar nada: abre la app con `?demo` al final de la dirección.

---

## Instalación (una sola vez, ~15 minutos)

### 1. Supabase: base de datos

1. Entra a <https://supabase.com/dashboard> → **New project**.
   Nombre: `tiempo-de-juego` · Región: **South America (São Paulo)** · guarda la contraseña de la base de datos.
2. **SQL Editor → New query** → pega todo [`supabase/1-esquema.sql`](supabase/1-esquema.sql) → **Run**.
3. **SQL Editor → New query** → pon los PIN (4 a 8 dígitos, distintos) y **Run**.
   ⚠️ Esto **no** se guarda en ningún archivo: el repositorio es público.

   ```sql
   insert into public.pines (rol, pin_hash) values
     ('admin',  extensions.crypt('PIN-ADMIN',  extensions.gen_salt('bf'))),
     ('tutora', extensions.crypt('PIN-TUTORA', extensions.gen_salt('bf')))
   on conflict (rol) do update set pin_hash = excluded.pin_hash;
   update public.sesiones set activa = false;  -- cierra las sesiones abiertas
   ```
4. **Authentication → Sign In / Providers**: activa **Allow anonymous sign-ins** y deja activado
   **Allow new users to sign up** (lo necesita el acceso anónimo) → Save.
5. **Project Settings → API Keys** (o botón **Connect**): copia la **Project URL** y la clave **publishable** (o *anon*).
   Pégalas en [`config.js`](config.js).

> Cómo funciona: cada dispositivo entra como usuario anónimo de Supabase y el servidor
> le da el rol solo si el PIN es correcto. Tras **15 PIN incorrectos** se bloquea 30 minutos,
> y cada intento queda en la pestaña Control.

### 2. GitHub: publicar la app

1. En <https://github.com/new> crea un repositorio **público** llamado `tiempo-de-juego` (vacío, sin README).
2. Sube esta carpeta al repositorio.
3. En el repositorio: **Settings → Pages → Branch: `main` / `(root)` → Save**.
   En 1–2 minutos queda en `https://TU-USUARIO.github.io/tiempo-de-juego/`.

> El código queda público, pero **los datos no**: la clave de `config.js` es pública por diseño
> y la base de datos solo responde a Admin y Tutora con su PIN (reglas RLS). Lo único visible
> sin PIN son las citas aprobadas (fecha, hora y minutos), para quien tenga el enlace.

### 3. Instalar en cada dispositivo

- **Android (Chrome):** abre el enlace → menú ⋮ → **Instalar app** / **Agregar a pantalla principal**.
- **iPhone (Safari):** abre el enlace → **Compartir** → **Agregar a inicio**.
- **PC:** abre el enlace en Chrome o Edge → ícono de instalar en la barra de direcciones.

Toca **🔔** en cada dispositivo para recibir avisos de mensajes y de fin del tiempo.

---

## Mantenimiento

| Qué | Cómo |
|---|---|
| Cambiar un PIN | Supabase → SQL Editor: <br>`update public.pines set pin_hash = extensions.crypt('NUEVO_PIN', extensions.gen_salt('bf')) where rol = 'tutora';` <br>`update public.sesiones set activa = false where rol = 'tutora';` (saca a quien tuviera la sesión abierta) |
| Cerrar sesión en un celular | Botón **Salir** (útil si Cristian usa el celular de la tutora) |
| Proyecto pausado | Supabase pausa tras 7 días sin uso. La tarea `.github/workflows/mantener-activo.yml` lo consulta cada 3 días. Si aun así se pausa: Dashboard → **Restore project**. |
| Actualizar la app | Cambia los archivos, sube el número en `CACHE` de `sw.js` y súbelos a GitHub. |

## Límites a saber

- La app **no bloquea** juegos en el dispositivo: lleva el registro, las aprobaciones y el temporizador.
  Para bloqueo real, combínala con **Google Family Link** (gratis).
- Los avisos llegan mientras la app está abierta o en segundo plano reciente; con la app cerrada del todo, no.
