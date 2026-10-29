'use strict';

(() => {
  const CFG = window.CONFIG || {};
  const NOMBRE = CFG.NOMBRE || 'Cristian';
  const TITULO = 'Organizador de tiempo';
  const TZ = zonaValida(CFG.ZONA_HORARIA) ? CFG.ZONA_HORARIA : 'America/Lima';
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const CONFIGURADO = Boolean(
    CFG.SUPABASE_URL && CFG.SUPABASE_KEY &&
    !CFG.SUPABASE_URL.includes('TU-PROYECTO') && !CFG.SUPABASE_KEY.startsWith('TU-')
  );
  const api = DEMO ? apiDemo() : CONFIGURADO && window.supabase ? apiSupabase() : null;

  const S = {
    usuario: null,
    rol: null,
    errorLogin: '',
    invitado: false, // entró sin contraseña: solo ve las citas aprobadas
    citas: null,
    errorCitas: '',
    tab: 'hoy',
    editando: false,
    cargado: false,
    hoy: '',
    d: { minutos: 60, sesiones: [], tareas: [], todasTareas: [], marcas: [], solicitudes: [], mensajes: [], resumenes: [], actividad: [] },
    visto: 0,
    ultimoMsg: 0,
    bajar: false,
    agotadas: new Set(),
    pendienteRender: false,
  };

  // ---------- Utilidades ----------

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const suma = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
  const cada5 = (n) => Math.min(600, Math.max(5, Math.round(n / 5) * 5));

  function zonaValida(z) {
    try { new Intl.DateTimeFormat('es', { timeZone: z }); return Boolean(z); } catch { return false; }
  }
  const fechaEn = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  function sumarDias(f, n) {
    const d = new Date(f + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function fechaLarga(f) {
    const t = new Date(f + 'T12:00:00Z').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  const fechaCorta = (f) => new Date(f + 'T12:00:00Z').toLocaleDateString('es', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
  const hora = (iso) => new Date(iso).toLocaleTimeString('es', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
  });
  const horaCorta = (t) => (t ? t.slice(0, 5) : '');
  const horaActual = () => new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ,
  }).format(new Date());
  function cuenta(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // ---------- Datos derivados ----------

  const NOMBRES = { admin: 'Admin', tutora: 'Tutora' };
  const esAdmin = () => S.rol === 'admin';
  const nombreRol = (rol) => NOMBRES[rol];
  const nombreDe = (uid) => nombreRol(S.d.sesiones.find((s) => s.uid === uid)?.rol) || (uid ? 'Alguien' : 'Sistema');
  const quienPide = (p) => (p === 'cristian' ? NOMBRE : nombreRol(p));
  const marcaDe = (tid) => S.d.marcas.find((m) => m.tarea_id === tid && m.fecha === S.hoy);
  const solicitud = (id) => S.d.solicitudes.find((s) => s.id === id);
  const finDe = (s) => Date.parse(s.iniciada_en) + s.minutos * 60000;
  const enCurso = (s) => s.iniciada_en && !s.terminada_en && Date.now() < finDe(s);

  function usadoDe(s) {
    if (!s.iniciada_en) return 0;
    const fin = s.terminada_en ? Date.parse(s.terminada_en) : Math.min(Date.now(), finDe(s));
    return Math.max(0, Math.min(s.minutos, Math.round((fin - Date.parse(s.iniciada_en)) / 60000)));
  }

  // Todo o nada: si están todas las tareas del día, gana los minutos fijados.
  function estadoHoy() {
    const total = S.d.tareas.length;
    const hechas = S.d.tareas.filter((t) => marcaDe(t.id)).length;
    const completo = hechas === total;
    const ganado = completo ? S.d.minutos : 0;
    const aprobadas = S.d.solicitudes.filter((s) => s.fecha === S.hoy && s.estado === 'aprobada');
    const aprobado = suma(aprobadas, (s) => s.minutos);
    return { total, hechas, completo, ganado, aprobadas, aprobado, disponible: ganado - aprobado };
  }

  // ---------- Avisos ----------

  let toastT;
  function aviso(texto, error = false) {
    const t = $('#toast');
    t.textContent = texto;
    t.className = 'visible' + (error ? ' error' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.className = ''), error ? 5000 : 2500);
  }

  function traducirError(e) {
    const m = e?.message || String(e);
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'Sin conexión. Revisa el internet e inténtalo de nuevo.';
    if (/Invalid login credentials/i.test(m)) return 'PIN incorrecto';
    if (/row-level security|permission denied/i.test(m)) return 'No tienes permiso para hacer eso.';
    return m;
  }

  function fallo(e) {
    console.error(e);
    aviso(traducirError(e), true);
  }

  async function notificar(titulo, cuerpo) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const opciones = { body: cuerpo, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'tiempo-juego', renotify: true };
      if (reg) await reg.showNotification(titulo, opciones);
      else new Notification(titulo, opciones);
    } catch { /* el navegador no permite avisos aquí */ }
  }

  function alarma() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.4, 0.8].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.25, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.35);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.35);
      });
    } catch { /* sin audio */ }
    navigator.vibrate?.([300, 120, 300, 120, 300]);
  }

  // ---------- Carga y sincronización ----------

  let recargaT = null;
  function programarRecarga() {
    clearTimeout(recargaT);
    recargaT = setTimeout(() => recargar().catch(fallo), 250);
  }

  async function recargar() {
    if (S.invitado) return cargarCitas();
    if (!S.usuario) return;
    S.hoy = fechaEn();
    const d = await api.cargar({ hoy: S.hoy, desde: sumarDias(S.hoy, -13), admin: esAdmin() });
    d.todasTareas = d.tareas;
    d.tareas = d.tareas.filter((t) => t.activa).sort((a, b) => a.creado_en.localeCompare(b.creado_en));
    S.d = d;
    revisarMensajesNuevos();
    S.cargado = true;
    render();
  }

  async function cargarCitas() {
    S.hoy = fechaEn();
    try {
      S.citas = await api.citas(S.hoy);
      S.errorCitas = '';
    } catch (e) {
      S.errorCitas = traducirError(e);
    }
    render();
  }

  // El modo sin contraseña se recuerda en el dispositivo (en el demo, solo en la pestaña).
  const CLAVE_INVITADO = 'tiempo-juego-invitado';
  function recordarInvitado(si) {
    try {
      const st = DEMO ? sessionStorage : localStorage;
      if (si) st.setItem(CLAVE_INVITADO, '1');
      else st.removeItem(CLAVE_INVITADO);
    } catch { /* sin almacenamiento */ }
  }
  function eraInvitado() {
    try { return (DEMO ? sessionStorage : localStorage).getItem(CLAVE_INVITADO) === '1'; } catch { return false; }
  }

  async function guardarResumen() {
    const e = estadoHoy();
    await api.guardarResumen({ fecha: S.hoy, total: e.total, hechas: e.hechas, minutos_ganados: e.ganado });
  }

  const noLeidos = () => S.d.mensajes.filter((m) => m.id > S.visto && m.autor !== S.usuario?.id).length;

  function marcarVisto() {
    if (S.tab !== 'chat' || document.hidden) return;
    S.visto = S.ultimoMsg;
    try { localStorage.setItem('tiempo-juego-visto-' + S.rol, String(S.visto)); } catch { /* sin almacenamiento */ }
    const b = $('#badge');
    if (b) b.hidden = true;
  }

  function revisarMensajesNuevos() {
    const ultimo = S.d.mensajes.at(-1)?.id || 0;
    if (S.ultimoMsg && ultimo > S.ultimoMsg && document.hidden) {
      const nuevo = S.d.mensajes.filter((m) => m.id > S.ultimoMsg && m.autor !== S.usuario.id).at(-1);
      if (nuevo) notificar(nombreDe(nuevo.autor), nuevo.texto || 'Nuevo mensaje');
    }
    S.ultimoMsg = ultimo;
  }

  async function abrirSesion({ usuario, rol }) {
    S.usuario = usuario;
    S.rol = rol;
    try { S.visto = Number(localStorage.getItem('tiempo-juego-visto-' + rol)) || 0; } catch { S.visto = 0; }
    S.tab = 'hoy';
    S.ultimoMsg = 0;
    api.escuchar(programarRecarga);
    await recargar();
  }

  // ---------- Pantallas ----------

  function render() {
    const app = $('#app');
    if (!api) { app.innerHTML = vistaSinConfig(); return; }
    if (S.invitado) {
      const scroll = $('.vista-citas')?.scrollTop || 0;
      app.innerHTML = vistaCitas();
      $('.vista-citas').scrollTop = scroll;
      return;
    }
    if (!S.usuario || !S.cargado) { app.innerHTML = vistaLogin(); return; }
    if (!$('#vista')) app.innerHTML = vistaShell();
    $('#yo-nombre').textContent = nombreRol(S.rol);
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('activo', b.dataset.tab === S.tab));
    const n = noLeidos();
    const badge = $('#badge');
    badge.hidden = !n || S.tab === 'chat';
    badge.textContent = n;
    $('#btn-avisos').hidden = !('Notification' in window) || Notification.permission !== 'default';
    renderVista();
  }

  // forzar = acción propia; si no, se espera a que termine de escribir.
  function renderVista(forzar = false) {
    const v = $('#vista');
    if (!v) return;
    if (S.tab === 'chat') {
      v.className = 'vista-chat';
      if (!$('#lista-msg')) v.innerHTML = vistaChat();
      pintarMensajes();
      return;
    }
    const foco = document.activeElement;
    const enVista = v.contains(foco);
    const escribiendo = enVista && foco.matches('input, textarea') && foco.value !== foco.defaultValue;
    if (escribiendo && !forzar) { S.pendienteRender = true; return; }
    S.pendienteRender = false;
    const idFoco = enVista ? foco.id : '';
    const scroll = v.scrollTop;
    v.className = '';
    v.innerHTML = S.tab === 'control' && esAdmin() ? vistaControl() : vistaHoy();
    v.scrollTop = scroll;
    if (idFoco) document.getElementById(idFoco)?.focus();
  }

  function vistaSinConfig() {
    const motivo = CONFIGURADO
      ? 'No se pudo cargar la librería de Supabase. Revisa el internet y recarga la página.'
      : 'Edita <code>config.js</code> con la URL y la clave pública de tu proyecto de Supabase (mira LEEME.md).';
    return `<main class="login">
      <div class="logo">🎮</div>
      <h1>${TITULO}</h1>
      <div class="aviso-config"><b>Falta conectar la base de datos.</b><br>${motivo}</div>
      <a class="btn primario" href="?demo">Probar en modo demo</a>
    </main>`;
  }

  function vistaLogin() {
    return `<main class="login">
      <div class="logo">🎮</div>
      <h1>${TITULO}</h1>
      <p class="sub">Escribe tu PIN</p>
      <form id="form-pin">
        <input id="pin" type="password" inputmode="numeric" autocomplete="off" autofocus
          placeholder="••••" minlength="4" maxlength="8" required aria-label="PIN">
        <button class="btn primario">Entrar</button>
      </form>
      <p class="error">${esc(S.errorLogin)}</p>
      ${DEMO ? '<p class="sub">Modo demo: PIN 1111 = Admin · 2222 = Tutora</p>' : ''}
      <div class="sin-pin">
        <button class="btn" data-acc="invitado">Entrar sin contraseña</button>
        <p class="sub">Solo para ver las citas aprobadas</p>
      </div>
    </main>`;
  }

  const bannerDemo = () => (DEMO
    ? '<div class="demo">MODO DEMO · datos solo en este navegador · <a href="?demo&reiniciar">reiniciar</a></div>'
    : '');

  function vistaShell() {
    return `<header class="barra">
        <div class="titulo">🎮 ${TITULO}</div>
        <div class="yo">
          <span id="yo-nombre"></span>
          <button class="btn-texto" id="btn-avisos" data-acc="avisos" hidden title="Activar avisos en este dispositivo" aria-label="Activar avisos">🔔</button>
          <button class="btn chico" data-acc="salir">Salir</button>
        </div>
      </header>
      ${bannerDemo()}
      <main id="vista"></main>
      <nav class="tabs">
        <button data-tab="hoy">✅<span>Hoy</span></button>
        <button data-tab="chat">💬<span>Chat</span><b class="badge" id="badge" hidden></b></button>
        ${esAdmin() ? '<button data-tab="control">🔒<span>Control</span></button>' : ''}
      </nav>`;
  }

  function vistaHoy() {
    const e = estadoHoy();
    const pct = e.total ? Math.round((e.hechas / e.total) * 100) : 100;
    const titulo = e.completo
      ? `<p class="grande ok">✅ ¡Tareas completas! Ganó ${e.ganado} min</p>`
      : `<p class="grande">Faltan ${e.total - e.hechas} de ${e.total} tareas</p>`;
    const pendientes = S.d.solicitudes.filter((s) => s.estado === 'pendiente').length;
    return `
      <section class="tarjeta">
        <p class="fecha-hoy">${esc(fechaLarga(S.hoy))} · ${esc(NOMBRE)}</p>
        ${titulo}
        <div class="progreso ${e.completo ? 'lleno' : ''}"><div style="width:${pct}%"></div></div>
        <div class="meta-fila">
          <span>🎯 Si completa todas gana <b>${S.d.minutos} min</b>; si falta una, 0.</span>
          <button class="btn chico" data-acc="meta">Cambiar</button>
        </div>
        <div class="balance">
          <div><b>${e.ganado}</b><small>min ganados</small></div>
          <div><b>${e.aprobado}</b><small>min aprobados</small></div>
          <div><b class="${e.disponible < 0 ? 'alerta' : ''}">${e.disponible}</b><small>min disponibles</small></div>
        </div>
        ${e.aprobadas.map(sesionHTML).join('')}
        ${pendientes ? `<button class="enlace-pend" data-tab="chat">⏳ ${pendientes} solicitud${pendientes > 1 ? 'es' : ''} pendiente${pendientes > 1 ? 's' : ''} en el chat</button>` : ''}
      </section>
      <section class="tarjeta">
        <h2>Tareas de hoy <button class="btn-texto" data-acc="editar">${S.editando ? 'Listo' : '✏️ Editar'}</button></h2>
        ${S.editando ? editorTareas() : listaTareas()}
      </section>`;
  }

  function sesionHTML(s) {
    const cuando = s.hora ? ` · ${horaCorta(s.hora)}` : '';
    if (!s.iniciada_en) {
      return `<div class="sesion"><div><b>${s.minutos} min</b> aprobados${cuando}</div>
        <button class="btn primario chico" data-acc="iniciar" data-id="${s.id}">▶ Empezar</button></div>`;
    }
    if (enCurso(s)) {
      return `<div class="sesion activa"><div>🎮 Jugando · quedan
        <b class="cuenta" data-fin="${finDe(s)}">${cuenta(finDe(s) - Date.now())}</b></div>
        <button class="btn chico" data-acc="terminar" data-id="${s.id}">■ Terminar</button></div>`;
    }
    const fin = s.terminada_en || new Date(finDe(s)).toISOString();
    return `<div class="sesion fin">Jugó ${usadoDe(s)} de ${s.minutos} min · ${hora(s.iniciada_en)}–${hora(fin)}</div>`;
  }

  function listaTareas() {
    if (!S.d.tareas.length) return '<p class="vacio">No hay tareas. Toca «Editar» para agregar.</p>';
    return `<ul class="lista-tareas">${S.d.tareas.map((t) => {
      const m = marcaDe(t.id);
      return `<li><button class="tarea ${m ? 'hecha' : ''}" data-acc="marcar" data-id="${t.id}" aria-pressed="${Boolean(m)}">
        <span class="caja">${m ? '✓' : ''}</span>
        <span class="t-texto"><span class="t-titulo">${esc(t.titulo)}</span>${m ? `<small>${esc(nombreDe(m.hecha_por))} · ${hora(m.hecha_en)}</small>` : ''}</span>
      </button></li>`;
    }).join('')}</ul>`;
  }

  function editorTareas() {
    const filas = S.d.tareas.map((t) => `
      <li class="edit-tarea">
        <input id="titulo-${t.id}" data-campo="titulo" data-id="${t.id}" value="${esc(t.titulo)}" maxlength="120" aria-label="Nombre de la tarea">
        <button class="btn-borrar" data-acc="borrar" data-id="${t.id}" aria-label="Eliminar">🗑</button>
      </li>`).join('');
    return `<ul class="lista-tareas">${filas}</ul>
      <form class="nueva-tarea" id="form-tarea">
        <input id="nueva-tarea" placeholder="Nueva tarea…" maxlength="120" required aria-label="Nueva tarea">
        <button class="btn primario">Agregar</button>
      </form>`;
  }

  function vistaChat() {
    return `<div class="lista-msg" id="lista-msg"></div>
      <form class="composer" id="form-msg">
        <button type="button" class="btn" data-acc="nueva-solicitud" aria-label="Nueva solicitud de juego">🎮＋</button>
        <input id="msg" autocomplete="off" placeholder="Mensaje…" maxlength="2000" aria-label="Mensaje">
        <button class="btn primario">Enviar</button>
      </form>`;
  }

  function pintarMensajes() {
    const lista = $('#lista-msg');
    const abajo = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 80;
    const primera = !lista.dataset.pintado;
    let html = '';
    let diaPrevio = '';
    for (const m of S.d.mensajes) {
      const dia = fechaEn(new Date(m.creado_en));
      if (dia !== diaPrevio) {
        html += `<div class="separador">${dia === S.hoy ? 'Hoy' : esc(fechaLarga(dia))}</div>`;
        diaPrevio = dia;
      }
      html += mensajeHTML(m);
    }
    lista.innerHTML = html || '<p class="vacio">Aún no hay mensajes.<br>Usa 🎮＋ para registrar una solicitud de juego.</p>';
    lista.dataset.pintado = '1';
    if (primera || abajo || S.bajar) {
      lista.scrollTop = lista.scrollHeight;
      S.bajar = false;
    }
    marcarVisto();
  }

  function mensajeHTML(m) {
    const mio = m.autor === S.usuario.id;
    const meta = `${mio ? '' : esc(nombreDe(m.autor)) + ' · '}${hora(m.creado_en)}`;
    if (m.tipo === 'solicitud') {
      return `<div class="msg con-tarjeta ${mio ? 'mio' : ''}"><div class="meta">${meta}</div>${solicitudHTML(solicitud(m.solicitud_id))}</div>`;
    }
    if (m.tipo !== 'texto') return `<div class="sistema">${esc(m.texto)} · ${hora(m.creado_en)}</div>`;
    return `<div class="msg ${mio ? 'mio' : ''}"><div class="burbuja">${esc(m.texto)}</div><div class="meta">${meta}</div></div>`;
  }

  function solicitudHTML(s) {
    if (!s) return '<div class="tarjeta sol"><p class="sub">Solicitud de hace más de 2 semanas</p></div>';
    const etiqueta = { pendiente: '⏳ Pendiente', aprobada: '✅ Aprobada', rechazada: '❌ Rechazada' }[s.estado];
    const dia = s.fecha === S.hoy ? 'Hoy' : fechaCorta(s.fecha);
    let extra = '';
    if (s.estado === 'pendiente') {
      if (s.fecha === S.hoy) {
        const e = estadoHoy();
        extra = e.completo
          ? `<p class="ok">Tareas completas · disponible: ${e.disponible} min</p>`
          : `<p class="alerta">Tareas ${e.hechas}/${e.total}: aún no ganó tiempo hoy</p>`;
      }
      extra += `<div class="acciones">
        <button class="btn primario chico" data-acc="aprobar" data-id="${s.id}">Aprobar</button>
        <button class="btn chico" data-acc="cambiar" data-id="${s.id}">Cambiar…</button>
        <button class="btn peligro chico" data-acc="rechazar" data-id="${s.id}">Rechazar</button>
      </div>`;
    } else if (s.decidido_por) {
      extra = `<p class="sub">${s.estado === 'aprobada' ? 'Aprobó' : 'Rechazó'} ${esc(nombreDe(s.decidido_por))} · ${hora(s.decidido_en)}</p>`;
    }
    if (s.estado === 'aprobada' && s.iniciada_en) {
      extra += `<p class="sub">${enCurso(s) ? '🎮 Jugando ahora' : `Jugó ${usadoDe(s)} de ${s.minutos} min`}</p>`;
    }
    return `<div class="tarjeta sol ${s.estado}">
      <div class="sol-cab"><span>🎮 Lo pide: ${esc(quienPide(s.pedido_por))}</span><span class="chip">${etiqueta}</span></div>
      <div class="sol-cuando"><b>${s.minutos} min</b> · ${esc(dia)}${s.hora ? ' · ' + horaCorta(s.hora) : ''}</div>
      ${s.nota ? `<p class="nota">“${esc(s.nota)}”</p>` : ''}
      ${extra}
    </div>`;
  }

  // ---------- Control (solo admin) ----------

  function vistaControl() {
    const filas = [];
    for (let i = 0; i < 7; i++) {
      const f = sumarDias(S.hoy, -i);
      const aprobadas = S.d.solicitudes.filter((s) => s.fecha === f && s.estado === 'aprobada');
      let r = S.d.resumenes.find((x) => x.fecha === f);
      if (i === 0) {
        const e = estadoHoy();
        r = { total: e.total, hechas: e.hechas, minutos_ganados: e.ganado };
      }
      filas.push({ f, r, aprobado: suma(aprobadas, (s) => s.minutos), jugado: suma(aprobadas, usadoDe) });
    }
    const diasOk = filas.filter((x) => x.r && x.r.hechas === x.r.total).length;
    const jugadoSemana = suma(filas, (x) => x.jugado);

    let actividad = '';
    let diaPrevio = '';
    for (const a of S.d.actividad) {
      const texto = textoActividad(a);
      if (!texto) continue;
      const dia = fechaEn(new Date(a.en));
      if (dia !== diaPrevio) {
        actividad += `<li class="dia-act">${dia === S.hoy ? 'Hoy' : esc(fechaLarga(dia))}</li>`;
        diaPrevio = dia;
      }
      const quien = a.accion === 'FALLO' ? 'Alguien' : nombreDe(a.usuario);
      actividad += `<li><span><b>${esc(quien)}</b> ${texto}</span><time>${hora(a.en)}</time></li>`;
    }

    return `<section class="tarjeta">
        <h2>Últimos 7 días</h2>
        <p class="sub"><b>${diasOk} de 7</b> con tareas completas · <b>${jugadoSemana} min</b> jugados</p>
        <table class="tabla">
          <thead><tr><th>Día</th><th>Tareas</th><th>Ganó</th><th>Aprobado</th><th>Jugó</th></tr></thead>
          <tbody>${filas.map(({ f, r, aprobado, jugado }) => `<tr>
            <td>${f === S.hoy ? 'Hoy' : esc(fechaCorta(f))}</td>
            ${r ? `<td class="${r.hechas === r.total ? 'si' : 'no'}">${r.hechas}/${r.total}</td><td>${r.minutos_ganados}</td>`
              : '<td class="sub">—</td><td class="sub">—</td>'}
            <td class="${r && aprobado > r.minutos_ganados ? 'alerta' : ''}">${aprobado || '—'}</td>
            <td>${jugado || '—'}</td></tr>`).join('')}
          </tbody>
        </table>
        <p class="sub">«—» = ese día nadie abrió la app. En naranja: se aprobó más de lo ganado.</p>
      </section>
      <section class="tarjeta">
        <h2>Actividad</h2>
        <ul class="actividad">${actividad || '<li class="vacio">Sin actividad todavía.</li>'}</ul>
        <p class="sub">Solo tú ves esto. Lo registra el servidor; nadie lo puede borrar desde la app.</p>
      </section>`;
  }

  function textoActividad(a) {
    const n = a.despues || {};
    const v = a.antes || {};
    const tarea = (id) => `«${esc(S.d.todasTareas.find((t) => t.id === id)?.titulo || 'una tarea')}»`;
    const otroDia = (f) => (f && f !== fechaEn(new Date(a.en)) ? ` (del ${esc(fechaCorta(f))})` : '');
    switch (`${a.tabla}.${a.accion}`) {
      case 'marcas.INSERT': return `marcó ${tarea(n.tarea_id)}${otroDia(n.fecha)}`;
      case 'marcas.DELETE': return `desmarcó ${tarea(v.tarea_id)}${otroDia(v.fecha)}`;
      case 'tareas.INSERT': return `creó la tarea «${esc(n.titulo)}»`;
      case 'tareas.DELETE': return `borró la tarea «${esc(v.titulo)}»`;
      case 'tareas.UPDATE':
        if (v.activa && !n.activa) return `eliminó la tarea «${esc(n.titulo)}»`;
        if (v.titulo !== n.titulo) return `renombró «${esc(v.titulo)}» → «${esc(n.titulo)}»`;
        return null;
      case 'solicitudes.INSERT': return `registró una solicitud de ${n.minutos} min (lo pide: ${esc(quienPide(n.pedido_por))})`;
      case 'solicitudes.UPDATE':
        if (v.estado !== n.estado) return `${n.estado === 'aprobada' ? 'aprobó' : 'rechazó'} ${n.minutos} min`;
        if (!v.iniciada_en && n.iniciada_en) return `inició el juego (${n.minutos} min)`;
        if (!v.terminada_en && n.terminada_en) return 'terminó el juego';
        return null;
      case 'ajustes.UPDATE': return `cambió el tiempo a ganar: ${v.minutos} → <b>${n.minutos} min</b>`;
      case 'acceso.ENTRO': return 'entró a la app';
      case 'acceso.FALLO': return '⚠️ escribió un PIN incorrecto';
      default: return `${esc(a.accion)} en ${esc(a.tabla)}`;
    }
  }

  // ---------- Sin contraseña: solo ver citas aprobadas ----------

  const nombreDia = (f) => (f === S.hoy ? 'Hoy' : f === sumarDias(S.hoy, 1) ? 'Mañana' : fechaLarga(f));

  function vistaCitas() {
    let cuerpo = '';
    let diaPrevio = '';
    for (const c of S.citas || []) {
      if (c.fecha !== diaPrevio) {
        cuerpo += `<p class="dia-cita">${esc(nombreDia(c.fecha))}</p>`;
        diaPrevio = c.fecha;
      }
      cuerpo += citaHTML(c);
    }
    if (!S.citas) cuerpo = S.errorCitas ? '' : '<p class="vacio">Cargando…</p>';
    else if (!S.citas.length) cuerpo = '<p class="vacio">No hay citas aprobadas por ahora.</p>';
    return `<header class="barra">
        <div class="titulo">🎮 ${TITULO}</div>
        <div class="yo">
          <span>Sin contraseña</span>
          <button class="btn chico" data-acc="salir-invitado">Salir</button>
        </div>
      </header>
      ${bannerDemo()}
      <main class="vista-citas">
        <section class="tarjeta">
          <p class="fecha-hoy">${esc(fechaLarga(S.hoy))}</p>
          <h2>📅 Citas aprobadas</h2>
          ${cuerpo}
          ${S.errorCitas ? `<p class="error">${esc(S.errorCitas)}</p>` : ''}
          <p class="sub">Solo lectura · se actualiza cada 30 segundos.</p>
        </section>
      </main>`;
  }

  function citaHTML(c) {
    const cuando = `<div><b>${c.hora ? horaCorta(c.hora) : 'Sin hora fija'}</b> · ${c.minutos} min</div>`;
    if (!c.iniciada_en) return `<div class="sesion">${cuando}<span>⏳ Por empezar</span></div>`;
    if (enCurso(c)) {
      return `<div class="sesion activa">${cuando}
        <div>🎮 Quedan <b class="cuenta" data-fin="${finDe(c)}">${cuenta(finDe(c) - Date.now())}</b></div></div>`;
    }
    const fin = c.terminada_en || new Date(finDe(c)).toISOString();
    return `<div class="sesion fin">${cuando}<span>✔ Terminada · ${hora(c.iniciada_en)}–${hora(fin)}</span></div>`;
  }

  // ---------- Diálogos ----------

  function dialogo(html) {
    const d = $('#dlg');
    d.innerHTML = html;
    const f = d.querySelector('form');
    return new Promise((resolver) => {
      f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        d.close();
        resolver(ev.submitter?.value === 'cancelar' ? null : Object.fromEntries(new FormData(f)));
      });
      d.addEventListener('cancel', () => resolver(null), { once: true });
      d.showModal();
    });
  }

  const botonesDialogo = (ok) => `<div class="acciones">
    <button class="btn" value="cancelar" formnovalidate>Cancelar</button>
    <button class="btn primario" value="ok">${ok}</button></div>`;

  // ---------- Acciones ----------

  async function decidir(s, estado, cambios = {}) {
    const minutos = cambios.minutos ?? s.minutos;
    const horaTxt = horaCorta('hora' in cambios ? cambios.hora : s.hora);
    if (estado === 'aprobada' && s.fecha === S.hoy) {
      const e = estadoHoy();
      if (minutos > e.disponible) {
        const pregunta = e.completo
          ? `Supera el tiempo disponible hoy (${e.disponible} min). ¿Aprobar igual?`
          : `${NOMBRE} aún no completa sus tareas (${e.hechas}/${e.total}). ¿Aprobar igual?`;
        if (!confirm(pregunta)) return;
      }
    }
    if (!(await api.decidir(s.id, { estado, ...cambios }))) {
      aviso('Esta solicitud ya fue decidida');
      return recargar();
    }
    const texto = estado === 'aprobada'
      ? `✅ ${nombreRol(S.rol)} aprobó ${minutos} min${horaTxt ? ' a las ' + horaTxt : ''}`
      : `❌ ${nombreRol(S.rol)} rechazó la solicitud de ${s.minutos} min`;
    await api.enviar({ tipo: 'decision', texto, solicitud_id: s.id });
    S.bajar = true;
    await recargar();
  }

  async function tiempoAgotado(s) {
    if (Date.now() - finDe(s) < 120000) {
      alarma();
      notificar('⏰ Se acabó el tiempo de juego', `${NOMBRE}: ${s.minutos} min cumplidos`);
    }
    try {
      if (await api.terminar(s.id)) {
        await api.enviar({ tipo: 'sesion', texto: `⏰ Se acabó el tiempo (${s.minutos} min)`, solicitud_id: s.id });
      }
      await recargar();
    } catch (e) { fallo(e); }
  }

  const ACCIONES = {
    async invitado() {
      Object.assign(S, { invitado: true, citas: null, errorCitas: '', errorLogin: '' });
      recordarInvitado(true);
      await cargarCitas();
    },

    'salir-invitado'() {
      Object.assign(S, { invitado: false, citas: null, errorCitas: '' });
      recordarInvitado(false);
      render();
    },

    async salir() {
      if (!confirm('¿Cerrar sesión en este dispositivo?')) return;
      await api.salir();
      Object.assign(S, { usuario: null, rol: null, errorLogin: '', cargado: false, editando: false });
      render();
    },

    async avisos() {
      const p = await Notification.requestPermission();
      aviso(p === 'granted' ? 'Avisos activados en este dispositivo' : 'Avisos bloqueados por el navegador');
      render();
    },

    async marcar(id) {
      const hecha = !marcaDe(id);
      if (hecha) S.d.marcas.push({ fecha: S.hoy, tarea_id: id, hecha_por: S.usuario.id, hecha_en: new Date().toISOString() });
      else S.d.marcas = S.d.marcas.filter((m) => !(m.tarea_id === id && m.fecha === S.hoy));
      renderVista(true);
      try {
        await api.marcar(S.hoy, id, hecha);
        await recargar();
        await guardarResumen();
      } catch (e) {
        await recargar().catch(() => {});
        throw e;
      }
    },

    async meta() {
      const datos = await dialogo(`<form class="form" method="dialog">
        <h2>🎯 Tiempo a ganar</h2>
        <p class="sub">Minutos que gana ${esc(NOMBRE)} si completa todas las tareas del día.</p>
        <label>Minutos<input type="number" name="minutos" value="${S.d.minutos}" min="0" max="600" step="5" required></label>
        ${botonesDialogo('Guardar')}
      </form>`);
      if (!datos) return;
      await api.guardarMinutos(Number(datos.minutos));
      aviso('Tiempo actualizado');
      await recargar();
      await guardarResumen();
    },

    editar() {
      S.editando = !S.editando;
      renderVista(true);
    },

    async borrar(id) {
      const t = S.d.tareas.find((x) => x.id === id);
      if (!confirm(`¿Eliminar la tarea «${t.titulo}»?`)) return;
      await api.actualizarTarea(id, { activa: false });
      await recargar();
      await guardarResumen();
    },

    async 'nueva-solicitud'() {
      const e = estadoHoy();
      const sugerido = cada5(e.disponible > 0 ? e.disponible : S.d.minutos);
      const datos = await dialogo(`<form class="form" method="dialog">
        <h2>🎮 Solicitud de juego para hoy</h2>
        <label>¿Quién lo pide?
          <select name="pedido_por">
            <option value="cristian">${esc(NOMBRE)}</option>
            <option value="tutora">${esc(nombreRol('tutora'))}</option>
          </select></label>
        <div class="fila">
          <label>Hora<input type="time" name="hora" value="${horaActual()}"></label>
          <label>Minutos<input type="number" name="minutos" value="${sugerido}" min="5" max="600" step="5" required></label>
        </div>
        <label>Nota (opcional)<input name="nota" maxlength="500" placeholder="Ej.: quiere jugar en línea con sus amigos"></label>
        ${botonesDialogo('Enviar')}
      </form>`);
      if (!datos) return;
      const minutos = Number(datos.minutos);
      const s = await api.crearSolicitud({
        fecha: S.hoy, hora: datos.hora || null, minutos, pedido_por: datos.pedido_por, nota: datos.nota.trim() || null,
      });
      const texto = `🎮 ${quienPide(datos.pedido_por)} pide ${minutos} min${datos.hora ? ' a las ' + datos.hora : ''}`;
      await api.enviar({ tipo: 'solicitud', texto, solicitud_id: s.id });
      S.bajar = true;
      await recargar();
    },

    aprobar: (id) => decidir(solicitud(id), 'aprobada'),

    async cambiar(id) {
      const s = solicitud(id);
      const datos = await dialogo(`<form class="form" method="dialog">
        <h2>Cambiar y aprobar</h2>
        <p class="sub">Lo pide: ${esc(quienPide(s.pedido_por))} · ${s.minutos} min${s.hora ? ' a las ' + horaCorta(s.hora) : ''}</p>
        <div class="fila">
          <label>Hora<input type="time" name="hora" value="${horaCorta(s.hora)}"></label>
          <label>Minutos<input type="number" name="minutos" value="${cada5(s.minutos)}" min="5" max="600" step="5" required></label>
        </div>
        ${botonesDialogo('Aprobar')}
      </form>`);
      if (!datos) return;
      await decidir(s, 'aprobada', { hora: datos.hora || null, minutos: Number(datos.minutos) });
    },

    async rechazar(id) {
      if (!confirm('¿Rechazar esta solicitud?')) return;
      await decidir(solicitud(id), 'rechazada');
    },

    async iniciar(id) {
      const s = solicitud(id);
      if (estadoHoy().aprobadas.some(enCurso)) return aviso('Ya hay un juego en curso');
      if (await api.iniciar(id)) {
        await api.enviar({ tipo: 'sesion', solicitud_id: id, texto: `▶ ${NOMBRE} empezó a jugar (${s.minutos} min)` });
      }
      await recargar();
    },

    async terminar(id) {
      const s = solicitud(id);
      if (!confirm('¿Terminar el juego ahora?')) return;
      if (await api.terminar(id)) {
        await api.enviar({ tipo: 'sesion', solicitud_id: id, texto: `■ Juego terminado · usó ${usadoDe(s)} de ${s.minutos} min` });
      }
      await recargar();
    },
  };

  const FORMULARIOS = {
    async 'form-pin'() {
      S.errorLogin = '';
      await abrirSesion(await api.entrar($('#pin').value.trim()));
    },

    async 'form-msg'() {
      const input = $('#msg');
      const texto = input.value.trim();
      if (!texto) return;
      input.value = '';
      try {
        await api.enviar({ tipo: 'texto', texto });
      } catch (e) {
        input.value = texto;
        throw e;
      }
      S.bajar = true;
      await recargar();
      input.focus();
    },

    async 'form-tarea'() {
      const input = $('#nueva-tarea');
      const titulo = input.value.trim();
      if (!titulo) return;
      input.value = '';
      await api.crearTarea({ titulo });
      await recargar();
      await guardarResumen();
    },
  };

  // ---------- Eventos ----------

  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('[data-tab]');
    if (tab) {
      S.tab = tab.dataset.tab;
      render();
      if (S.tab !== 'chat') renderVista(true);
      return;
    }
    const btn = ev.target.closest('[data-acc]');
    const accion = btn && !btn.disabled && ACCIONES[btn.dataset.acc];
    if (!accion) return;
    btn.disabled = true;
    try { await accion(btn.dataset.id); } catch (e) { fallo(e); } finally { btn.disabled = false; }
  });

  document.addEventListener('submit', async (ev) => {
    const f = ev.target;
    if (f.closest('dialog')) return; // lo maneja dialogo()
    ev.preventDefault();
    const manejar = FORMULARIOS[f.id];
    if (!manejar) return;
    const boton = f.querySelector('button:not([type=button])');
    if (boton) boton.disabled = true;
    try {
      await manejar(f);
    } catch (e) {
      if (f.id === 'form-pin') {
        S.errorLogin = traducirError(e);
        render();
        $('#pin')?.focus();
      } else fallo(e);
    } finally {
      if (boton) boton.disabled = false;
    }
  });

  document.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (el.dataset.campo !== 'titulo') return;
    const t = S.d.tareas.find((x) => x.id === el.dataset.id);
    const titulo = el.value.trim();
    if (!t || !titulo || titulo === t.titulo) { el.value = t?.titulo ?? ''; return; }
    try {
      await api.actualizarTarea(t.id, { titulo });
      el.defaultValue = titulo;
      aviso('Guardado');
      await recargar();
    } catch (e) { fallo(e); }
  });

  document.addEventListener('focusout', () => {
    if (S.pendienteRender) setTimeout(() => S.pendienteRender && renderVista(), 60);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !(S.cargado || S.invitado)) return;
    programarRecarga();
    if (S.cargado) marcarVisto();
  });
  window.addEventListener('online', () => (S.cargado || S.invitado) && programarRecarga());

  // Sin contraseña no hay tiempo real: se consulta cada 30 segundos.
  setInterval(() => {
    if (S.invitado && !document.hidden) programarRecarga();
  }, 30000);

  // Cuenta regresiva, fin del tiempo y cambio de día.
  setInterval(() => {
    if (!S.cargado && !S.invitado) return;
    let cambio = false;
    document.querySelectorAll('[data-fin]').forEach((el) => {
      const resta = Number(el.dataset.fin) - Date.now();
      if (resta > 0) el.textContent = cuenta(resta);
      else cambio = true;
    });
    for (const s of S.cargado ? S.d.solicitudes : []) {
      if (s.estado === 'aprobada' && s.iniciada_en && !s.terminada_en && Date.now() >= finDe(s) && !S.agotadas.has(s.id)) {
        S.agotadas.add(s.id);
        tiempoAgotado(s);
        cambio = true;
      }
    }
    if (cambio) {
      if (S.invitado) render();
      else renderVista();
    }
    const hoy = fechaEn();
    if (hoy !== S.hoy) {
      S.hoy = hoy;
      programarRecarga();
    }
  }, 1000);

  // ---------- Conexión con Supabase ----------

  function apiSupabase() {
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    let uid = null;
    return {
      // Cada dispositivo es un usuario anónimo de Supabase; el PIN (verificado
      // en el servidor) le asigna el rol. No hay correos ni contraseñas.
      async sesion() {
        const { data } = await sb.auth.getSession();
        uid = data.session?.user?.id || null;
        if (!uid) return null;
        const rol = ok(await sb.rpc('mi_rol'));
        return rol ? { usuario: { id: uid }, rol } : null;
      },
      async entrar(pin) {
        if (!uid) {
          const { data, error } = await sb.auth.signInAnonymously();
          if (error) throw error;
          uid = data.user.id;
        }
        const rol = ok(await sb.rpc('entrar_con_pin', { p_pin: pin }));
        if (!rol) throw new Error('PIN incorrecto');
        return { usuario: { id: uid }, rol };
      },
      async salir() {
        await sb.removeAllChannels();
        await sb.rpc('salir_de_sesion');
        await sb.auth.signOut();
        uid = null;
      },
      async cargar({ hoy, desde, admin }) {
        const consultas = [
          sb.from('ajustes').select('minutos').eq('id', 1).single(),
          sb.from('sesiones').select('uid, rol'),
          sb.from('tareas').select('*'),
          sb.from('marcas').select('*').eq('fecha', hoy),
          sb.from('solicitudes').select('*').gte('fecha', desde).order('creado_en'),
          sb.from('mensajes').select('*').order('id', { ascending: false }).limit(200),
        ];
        if (admin) {
          consultas.push(
            sb.from('resumen_dia').select('*').gte('fecha', desde),
            sb.from('actividad').select('*').order('id', { ascending: false }).limit(60),
          );
        }
        const [ajustes, sesiones, tareas, marcas, solicitudes, mensajes, resumenes = [], actividad = []] =
          (await Promise.all(consultas)).map(ok);
        return { minutos: ajustes.minutos, sesiones, tareas, marcas, solicitudes, mensajes: mensajes.reverse(), resumenes, actividad };
      },
      async marcar(fecha, tarea_id, hecha) {
        ok(hecha
          ? await sb.from('marcas').upsert({ fecha, tarea_id, hecha_por: uid }, { onConflict: 'fecha,tarea_id', ignoreDuplicates: true })
          : await sb.from('marcas').delete().match({ fecha, tarea_id }));
      },
      async crearTarea(t) { ok(await sb.from('tareas').insert(t)); },
      async actualizarTarea(id, cambios) { ok(await sb.from('tareas').update(cambios).eq('id', id)); },
      async guardarMinutos(minutos) {
        if (!ok(await sb.from('ajustes').update({ minutos }).eq('id', 1).select()).length) {
          throw new Error('No tienes permiso para hacer eso.');
        }
      },
      async crearSolicitud(s) {
        return ok(await sb.from('solicitudes').insert({ ...s, creado_por: uid }).select().single());
      },
      async decidir(id, cambios) {
        return ok(await sb.from('solicitudes').update(cambios).eq('id', id).eq('estado', 'pendiente').select()).length > 0;
      },
      // Sin contraseña: la función del servidor solo devuelve fecha, hora, minutos y temporizador.
      async citas(desde) { return ok(await sb.rpc('citas_aprobadas', { p_desde: desde })); },
      async iniciar(id) { return ok(await sb.rpc('iniciar_juego', { p_id: id })); },
      async terminar(id) { return ok(await sb.rpc('terminar_juego', { p_id: id })); },
      async enviar(m) { ok(await sb.from('mensajes').insert({ ...m, autor: uid })); },
      async guardarResumen(r) {
        ok(await sb.from('resumen_dia').upsert({ ...r, actualizado_en: new Date().toISOString() }));
      },
      escuchar(alCambiar) {
        sb.channel('cambios')
          .on('postgres_changes', { event: '*', schema: 'public' }, alCambiar)
          .subscribe((estado) => { if (estado === 'SUBSCRIBED') alCambiar(); });
      },
    };
  }

  // ---------- Modo demo (sin internet, datos en este navegador) ----------

  function apiDemo() {
    const CLAVE = 'tiempo-juego-demo-v2';
    if (params.has('reiniciar')) {
      try { localStorage.removeItem(CLAVE); } catch { /* sin almacenamiento */ }
      history.replaceState(null, '', '?demo');
    }
    const PINES = { 1111: 'admin', 2222: 'tutora' };
    const ROL_DE = { 'demo-admin': 'admin', 'demo-tutora': 'tutora' };
    const canal = 'BroadcastChannel' in window ? new BroadcastChannel(CLAVE) : null;
    const ahora = () => new Date().toISOString();
    const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const copia = (x) => JSON.parse(JSON.stringify(x));
    let oyente = null;
    let yo = null;
    try { yo = sessionStorage.getItem(CLAVE + '-yo'); } catch { /* sin almacenamiento */ }

    const semilla = () => ({
      seq: 1,
      ajustes: { id: 1, minutos: 60 },
      tareas: ['Tareas del colegio', 'Ordenar su cuarto', 'Leer 20 minutos']
        .map((titulo, i) => ({ id: nuevoId(), titulo, activa: true, creado_en: new Date(Date.now() + i).toISOString() })),
      marcas: [], resumen_dia: [], solicitudes: [], mensajes: [], actividad: [],
    });
    let db = null;
    const leer = () => {
      try { const x = JSON.parse(localStorage.getItem(CLAVE)); if (x) return x; } catch { /* sin almacenamiento */ }
      return db || semilla();
    };
    db = leer();

    function cambiar(fn) {
      db = leer();
      const r = fn();
      try { localStorage.setItem(CLAVE, JSON.stringify(db)); } catch { /* queda en memoria */ }
      canal?.postMessage('cambio');
      setTimeout(() => oyente?.(), 0);
      return r;
    }
    if (canal) canal.onmessage = () => oyente?.();
    const registrar = (tabla, accion, antes, despues) => db.actividad.push({
      id: db.seq++, en: ahora(), usuario: yo, tabla, accion, antes: antes && copia(antes), despues: despues && copia(despues),
    });
    const sol = (id) => db.solicitudes.find((x) => x.id === id);
    function actualizar(tabla, fila, cambios) {
      const antes = copia(fila);
      Object.assign(fila, cambios);
      registrar(tabla, 'UPDATE', antes, fila);
    }

    return {
      async sesion() { return yo ? { usuario: { id: yo }, rol: ROL_DE[yo] } : null; },
      async entrar(pin) {
        const rol = PINES[pin];
        yo = rol ? 'demo-' + rol : null;
        cambiar(() => registrar('acceso', rol ? 'ENTRO' : 'FALLO', null, rol ? { rol } : null));
        if (!rol) throw new Error('PIN incorrecto (en el demo: 1111 o 2222)');
        try { sessionStorage.setItem(CLAVE + '-yo', yo); } catch { /* sin almacenamiento */ }
        return { usuario: { id: yo }, rol };
      },
      async salir() {
        yo = null;
        oyente = null;
        try { sessionStorage.removeItem(CLAVE + '-yo'); } catch { /* sin almacenamiento */ }
      },
      async cargar({ hoy, desde, admin }) {
        db = leer();
        return copia({
          minutos: db.ajustes.minutos,
          sesiones: Object.entries(ROL_DE).map(([uid, rol]) => ({ uid, rol })),
          tareas: db.tareas,
          marcas: db.marcas.filter((m) => m.fecha === hoy),
          solicitudes: db.solicitudes.filter((s) => s.fecha >= desde),
          mensajes: db.mensajes.slice(-200),
          resumenes: admin ? db.resumen_dia.filter((r) => r.fecha >= desde) : [],
          actividad: admin ? db.actividad.slice(-60).reverse() : [],
        });
      },
      async marcar(fecha, tarea_id, hecha) {
        cambiar(() => {
          const i = db.marcas.findIndex((m) => m.fecha === fecha && m.tarea_id === tarea_id);
          if (hecha && i < 0) {
            const m = { fecha, tarea_id, hecha_por: yo, hecha_en: ahora() };
            db.marcas.push(m);
            registrar('marcas', 'INSERT', null, m);
          } else if (!hecha && i >= 0) {
            registrar('marcas', 'DELETE', db.marcas[i], null);
            db.marcas.splice(i, 1);
          }
        });
      },
      async crearTarea(t) {
        cambiar(() => {
          const n = { id: nuevoId(), activa: true, creado_en: ahora(), ...t };
          db.tareas.push(n);
          registrar('tareas', 'INSERT', null, n);
        });
      },
      async actualizarTarea(id, cambios) {
        cambiar(() => actualizar('tareas', db.tareas.find((x) => x.id === id), cambios));
      },
      async guardarMinutos(minutos) { cambiar(() => actualizar('ajustes', db.ajustes, { minutos })); },
      async crearSolicitud(s) {
        return cambiar(() => {
          const n = {
            id: nuevoId(), estado: 'pendiente', creado_por: yo, creado_en: ahora(),
            decidido_por: null, decidido_en: null, iniciada_en: null, terminada_en: null, ...s,
          };
          db.solicitudes.push(n);
          registrar('solicitudes', 'INSERT', null, n);
          return copia(n);
        });
      },
      async decidir(id, cambios) {
        return cambiar(() => {
          const s = sol(id);
          if (!s || s.estado !== 'pendiente') return false;
          actualizar('solicitudes', s, { ...cambios, decidido_por: yo, decidido_en: ahora() });
          return true;
        });
      },
      async citas(desde) {
        db = leer();
        return db.solicitudes
          .filter((s) => s.estado === 'aprobada' && s.fecha >= desde)
          .sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.hora || '99').localeCompare(b.hora || '99')
            || a.creado_en.localeCompare(b.creado_en))
          .map((s) => ({
            id: s.id, fecha: s.fecha, hora: s.hora, minutos: s.minutos, iniciada_en: s.iniciada_en, terminada_en: s.terminada_en,
          }));
      },
      async iniciar(id) {
        return cambiar(() => {
          const s = sol(id);
          if (!s || s.estado !== 'aprobada' || s.iniciada_en) return false;
          actualizar('solicitudes', s, { iniciada_en: ahora() });
          return true;
        });
      },
      async terminar(id) {
        return cambiar(() => {
          const s = sol(id);
          if (!s || !s.iniciada_en || s.terminada_en) return false;
          const fin = Math.min(Date.now(), Date.parse(s.iniciada_en) + s.minutos * 60000);
          actualizar('solicitudes', s, { terminada_en: new Date(fin).toISOString() });
          return true;
        });
      },
      async enviar(m) {
        cambiar(() => db.mensajes.push({ id: db.seq++, autor: yo, tipo: 'texto', texto: '', solicitud_id: null, creado_en: ahora(), ...m }));
      },
      async guardarResumen(r) {
        cambiar(() => {
          db.resumen_dia = db.resumen_dia.filter((x) => x.fecha !== r.fecha).concat({ ...r, actualizado_en: ahora() });
        });
      },
      escuchar(alCambiar) { oyente = alCambiar; },
    };
  }

  // ---------- Arranque ----------

  async function arrancar() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    if (api && eraInvitado()) {
      S.invitado = true;
      return cargarCitas();
    }
    if (api) {
      try {
        const sesion = await api.sesion();
        if (sesion) await abrirSesion(sesion);
      } catch (e) {
        S.usuario = null;
        S.errorLogin = traducirError(e);
      }
    }
    render();
  }

  arrancar();
})();
