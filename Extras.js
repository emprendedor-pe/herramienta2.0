// ============================================================
// LUNARA 2.0 - extras.js  (archivo NUEVO, va junto a index.html en GitHub)
//   1) Botón 📞 de llamada de voz manos libres (detecta cuándo hablás, transcribe, responde y habla)
//   2) Acciones rápidas "Crear evento" y "Guardar nota" en lenguaje natural
// Se carga con una sola línea en index.html:  <script src="extras.js"></script>
// ============================================================
(function () {
    'use strict';
    if (window.__lunaraExtras) return;
    window.__lunaraExtras = true;

    // ---------- Comprobación de que el index tiene lo necesario ----------
    const faltan = [];
    if (typeof APPS_SCRIPT_URL === 'undefined') faltan.push('APPS_SCRIPT_URL');
    if (typeof getToken !== 'function') faltan.push('getToken');
    if (typeof addMessage !== 'function') faltan.push('addMessage');
    if (typeof textoParaVoz !== 'function') faltan.push('textoParaVoz');
    if (typeof blobAWav16k !== 'function') faltan.push('blobAWav16k');
    if (typeof bufferABase64 !== 'function') faltan.push('bufferABase64');
    if (typeof audioAUrl !== 'function') faltan.push('audioAUrl');
    if (typeof cacheAudio === 'undefined') faltan.push('cacheAudio');
    if (typeof SILENCIO === 'undefined') faltan.push('SILENCIO');
    if (faltan.length) { console.warn('extras.js: faltan funciones del index:', faltan.join(', ')); return; }

    // ---------- Ajustes de la llamada ----------
    const CFG = {
        BARGE_IN: true,        // poder interrumpirla hablando. Si se corta sola (eco del parlante), ponelo en false o usá auriculares
        SILENCIO_MS: 1100,     // silencio que indica "ya terminé de hablar"
        MIN_HABLA_MS: 350,     // ruidos más cortos que esto se ignoran
        MAX_TURNO_MS: 30000,   // máximo por turno
        UMBRAL_MIN: 0.018,     // volumen mínimo para considerar voz
        FACTOR_RUIDO: 3.2,     // la voz debe superar 3.2 veces el ruido de fondo
        BARGE_FACTOR: 2.2,
        BARGE_MS: 400,
        CHUNK: 200,            // caracteres por fragmento de voz (más corto = empieza a hablar antes)
        STT_TIMEOUT: 45000,
        CHAT_TIMEOUT: 60000,
        TTS_TIMEOUT: 45000
    };

    // ---------- Estado ----------
    let activa = false, estado = 'inactiva';
    let stream = null, ctx = null, analyser = null, datos = null, timerVAD = null, timerReloj = null;
    let segmento = null, hablo = false, inicioHabla = 0, ultimaVoz = 0, inicioSeg = 0, bargeDesde = null;
    let umbral = CFG.UMBRAL_MIN, idTurno = 0, audioEl = null, detenerReproduccion = null, t0 = 0;

    // ---------- Interfaz ----------
    const estilo = document.createElement('style');
    estilo.textContent = `
        #call-btn { margin-left: auto; }
        #llamada-overlay { display: none; position: absolute; inset: 0; z-index: 200; background: radial-gradient(circle at 50% 30%, #1d2b33, #0b141a 70%); color: #e9edef; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; }
        #llamada-overlay.abierta { display: flex; }
        #llamada-avatar { width: 132px; height: 132px; border-radius: 50%; object-fit: cover; object-position: top; border: 3px solid #25d366; box-shadow: 0 0 0 0 rgba(37,211,102,.5); }
        #llamada-overlay.hablando #llamada-avatar { animation: latido 1.2s infinite; }
        @keyframes latido { 0% { box-shadow: 0 0 0 0 rgba(37,211,102,.55); } 100% { box-shadow: 0 0 0 26px rgba(37,211,102,0); } }
        #llamada-nombre { font-size: 22px; font-weight: 700; }
        #llamada-reloj { font-size: 14px; color: #8696a0; }
        #llamada-estado { font-size: 15px; min-height: 22px; max-width: 320px; }
        #llamada-medidor { width: 180px; height: 6px; background: #2a3942; border-radius: 4px; overflow: hidden; }
        #llamada-barra { height: 100%; width: 0; background: #00a884; transition: width .08s linear; }
        #llamada-colgar { margin-top: 18px; width: 68px; height: 68px; border: none; border-radius: 50%; background: #f44336; color: #fff; font-size: 30px; cursor: pointer; transform: rotate(135deg); }
    `;
    document.head.appendChild(estilo);

    const overlay = document.createElement('div');
    overlay.id = 'llamada-overlay';
    overlay.innerHTML =
        '<img id="llamada-avatar" alt="Lunara">' +
        '<div id="llamada-nombre">Lunara ❤️</div>' +
        '<div id="llamada-reloj">00:00</div>' +
        '<div id="llamada-estado">Conectando…</div>' +
        '<div id="llamada-medidor"><div id="llamada-barra"></div></div>' +
        '<button id="llamada-colgar" aria-label="Colgar">📞</button>';
    (document.getElementById('app') || document.body).appendChild(overlay);

    const btn = document.createElement('button');
    btn.id = 'call-btn'; btn.className = 'btn-icon'; btn.textContent = '📞';
    btn.setAttribute('aria-label', 'Llamar a Lunara');
    btn.addEventListener('click', iniciarLlamada);
    (document.getElementById('header') || document.body).appendChild(btn);
    document.getElementById('llamada-colgar').addEventListener('click', colgar);

    function setEstado(nuevo, texto) {
        estado = nuevo;
        overlay.classList.toggle('hablando', nuevo === 'hablando');
        document.getElementById('llamada-estado').textContent = texto || '';
    }

    // ---------- Utilidades ----------
    async function postJSON(payload, timeoutMs) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
        try {
            const res = await fetch(APPS_SCRIPT_URL, {
                method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(Object.assign({ token: getToken() }, payload)), signal: ctrl.signal
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        } finally { clearTimeout(t); }
    }

    function partir(texto, max) {
        const frases = texto.match(/[^.!?…]+[.!?…]*\s*/g) || [texto];
        const out = []; let cur = '';
        frases.forEach(f => {
            if (cur && (cur + f).length > max) { out.push(cur.trim()); cur = ''; }
            if (f.length > max) {
                let resto = f;
                while (resto.length > max) {
                    let c = resto.lastIndexOf(', ', max);
                    if (c < max * 0.4) c = resto.lastIndexOf(' ', max);
                    if (c < 1) c = max;
                    out.push(resto.slice(0, c + 1).trim()); resto = resto.slice(c + 1);
                }
                cur = resto;
            } else cur += f;
        });
        if (cur.trim()) out.push(cur.trim());
        return out.filter(Boolean);
    }

    function nivelVoz() {
        analyser.getFloatTimeDomainData(datos);
        let s = 0;
        for (let i = 0; i < datos.length; i++) s += datos[i] * datos[i];
        return Math.sqrt(s / datos.length);
    }

    // ---------- Grabación por turnos ----------
    function empezarSegmento() {
        const partes = [];
        const rec = new MediaRecorder(stream);
        rec.ondataavailable = e => { if (e.data && e.data.size) partes.push(e.data); };
        rec.start();
        segmento = { rec: rec, partes: partes };
        hablo = false; inicioSeg = Date.now(); ultimaVoz = 0; bargeDesde = null;
    }

    function descartarSegmento() {
        if (!segmento) return;
        segmento.rec.onstop = null;
        try { segmento.rec.stop(); } catch (_) {}
        segmento = null;
    }

    function reiniciarSegmento() { descartarSegmento(); empezarSegmento(); }

    function cerrarSegmento() {
        const seg = segmento; segmento = null;
        if (!seg) return;
        setEstado('procesando', 'Pensando…');
        seg.rec.onstop = () => {
            const blob = new Blob(seg.partes, { type: seg.rec.mimeType || 'audio/webm' });
            procesarTurno(blob);
        };
        try { seg.rec.stop(); } catch (_) { volverAEscuchar(); }
    }

    function volverAEscuchar() {
        if (!activa) return;
        setEstado('escuchando', 'Escuchando… hablá cuando quieras');
        empezarSegmento();
    }

    function interrumpir() {
        idTurno++;
        if (detenerReproduccion) detenerReproduccion();
        if (typeof hayVoz !== 'undefined' && hayVoz) window.speechSynthesis.cancel();
        setEstado('escuchando', 'Te escucho…');
        empezarSegmento();
        hablo = true; inicioHabla = Date.now(); ultimaVoz = Date.now();
    }

    function tick() {
        if (!activa) return;
        const nivel = nivelVoz(), ahora = Date.now();
        document.getElementById('llamada-barra').style.width = Math.min(100, (nivel / (umbral * 2)) * 100) + '%';

        if (estado === 'escuchando' && segmento) {
            if (nivel > umbral) {
                if (!hablo) { hablo = true; inicioHabla = ahora; }
                ultimaVoz = ahora;
            } else if (hablo && ahora - ultimaVoz > CFG.SILENCIO_MS) {
                if (ultimaVoz - inicioHabla >= CFG.MIN_HABLA_MS) cerrarSegmento(); else reiniciarSegmento();
            } else if (!hablo && ahora - inicioSeg > 12000) {
                reiniciarSegmento();
            }
            if (hablo && ahora - inicioHabla > CFG.MAX_TURNO_MS) cerrarSegmento();
        } else if (estado === 'hablando' && CFG.BARGE_IN) {
            if (nivel > umbral * CFG.BARGE_FACTOR) {
                if (!bargeDesde) bargeDesde = ahora;
                else if (ahora - bargeDesde > CFG.BARGE_MS) { bargeDesde = null; interrumpir(); }
            } else bargeDesde = null;
        }
    }

    // ---------- Un turno: audio -> texto -> respuesta -> voz ----------
    const RUIDO_STT = /^(gracias por ver.*|subt[ií]tulos.*|suscr[ií]bete.*|amara\.org.*|[\s.,…]*)$/i;

    async function procesarTurno(blob) {
        const id = ++idTurno;
        try {
            if (blob.size < 3000) return;
            const wav = await blobAWav16k(blob);
            const stt = await postJSON({ action: 'stt', audio: bufferABase64(wav), formato: 'wav' }, CFG.STT_TIMEOUT);
            if (!activa || id !== idTurno) return;
            if (!stt.ok) throw new Error('No pude transcribir (' + String(stt.error || '').slice(0, 80) + ')');
            const texto = String(stt.texto || '').trim();
            if (texto.length < 2 || RUIDO_STT.test(texto)) return;

            addMessage('🎤 ' + texto, 'sent');
            const chat = await postJSON({ mensaje: texto, modo: 'llamada' }, CFG.CHAT_TIMEOUT);
            if (!activa || id !== idTurno) return;
            if (!chat.ok) throw new Error(String(chat.error || 'error del servidor').slice(0, 100));
            addMessage(chat.respuesta, 'received');
            await hablarLlamada(chat.respuesta, id);
        } catch (e) {
            console.error('Turno de llamada:', e);
            if (activa && id === idTurno) setEstado('procesando', '⚠️ ' + (e.name === 'AbortError' ? 'Tardó demasiado' : e.message));
            await new Promise(r => setTimeout(r, 1800));
        } finally {
            if (activa && id === idTurno) volverAEscuchar();
        }
    }

    function audioParaFrase(frase) {
        const guardado = cacheAudio.get(frase);
        if (guardado) return Promise.resolve(guardado);
        return postJSON({ action: 'tts', texto: frase }, CFG.TTS_TIMEOUT)
            .then(d => { if (!d.ok) throw new Error(d.error); const u = audioAUrl(d); cacheAudio.set(frase, u); return u; })
            .catch(e => { console.warn('Voz de la llamada falló:', e); return null; });
    }

    function reproducir(url) {
        return new Promise(resolve => {
            detenerReproduccion = () => { try { audioEl.pause(); } catch (_) {} resolve(); };
            audioEl.onended = () => resolve();
            audioEl.onerror = () => resolve();
            audioEl.src = url;
            audioEl.play().catch(() => resolve());
        });
    }

    function hablarNavegador(texto) {
        return new Promise(resolve => {
            if (typeof hayVoz === 'undefined' || !hayVoz) return resolve();
            const u = new SpeechSynthesisUtterance(texto);
            const v = (typeof mejorVozEs === 'function') ? mejorVozEs() : null;
            u.lang = v ? v.lang : 'es-ES'; if (v) u.voice = v;
            u.onend = resolve; u.onerror = resolve;
            detenerReproduccion = () => { window.speechSynthesis.cancel(); resolve(); };
            window.speechSynthesis.speak(u);
        });
    }

    async function hablarLlamada(texto, id) {
        const limpio = textoParaVoz(texto);
        if (!limpio) return;
        const frases = partir(limpio, CFG.CHUNK);
        const pedidos = frases.map(audioParaFrase);   // se piden todas a la vez; suena la primera apenas llega
        for (let i = 0; i < frases.length; i++) {
            const url = await pedidos[i];
            if (!activa || id !== idTurno) return;
            if (estado !== 'hablando') {
                bargeDesde = null;
                setEstado('hablando', CFG.BARGE_IN ? 'Lunara está hablando… (hablá para interrumpirla)' : 'Lunara está hablando…');
            }
            if (url) await reproducir(url); else await hablarNavegador(frases[i]);
            if (!activa || id !== idTurno) return;
        }
    }

    // ---------- Iniciar / colgar ----------
    async function iniciarLlamada() {
        if (activa) return;
        if (typeof busy !== 'undefined' && busy) { if (typeof aviso === 'function') aviso('Esperá a que termine lo que está haciendo'); return; }
        if (!navigator.mediaDevices || !window.MediaRecorder) { alert('Tu navegador no permite llamadas de voz.'); return; }
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        } catch (e) { alert('No se pudo acceder al micrófono. Revisá el permiso del navegador.'); return; }

        if (typeof detenerAudio === 'function') detenerAudio();
        activa = true; busy = true; idTurno = 0; t0 = Date.now();

        // iOS/Safari: el audio solo suena si se "desbloquea" con este mismo toque
        audioEl = new Audio(); audioEl.src = SILENCIO; audioEl.play().catch(() => {});
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC(); if (ctx.resume) await ctx.resume();
        analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        datos = new Float32Array(analyser.fftSize);

        const av = document.getElementById('avatar-lunara');
        document.getElementById('llamada-avatar').src = (av && av.src) || 'lunita1.png';
        overlay.classList.add('abierta');
        setEstado('procesando', 'Conectando…');

        // Calibrar el ruido de fondo (0,7 s)
        let suma = 0, n = 0;
        const fin = Date.now() + 700;
        await new Promise(res => { const c = setInterval(() => { suma += nivelVoz(); n++; if (Date.now() > fin) { clearInterval(c); res(); } }, 50); });
        umbral = Math.max(CFG.UMBRAL_MIN, (suma / Math.max(1, n)) * CFG.FACTOR_RUIDO);

        timerVAD = setInterval(tick, 60);
        timerReloj = setInterval(() => {
            const s = Math.floor((Date.now() - t0) / 1000);
            document.getElementById('llamada-reloj').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
        }, 1000);
        volverAEscuchar();
    }

    function colgar() {
        if (!activa) return;
        const s = Math.floor((Date.now() - t0) / 1000);
        activa = false; idTurno++;
        clearInterval(timerVAD); clearInterval(timerReloj);
        descartarSegmento();
        if (detenerReproduccion) detenerReproduccion();
        if (typeof hayVoz !== 'undefined' && hayVoz) window.speechSynthesis.cancel();
        try { audioEl.pause(); } catch (_) {}
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (ctx && ctx.close) ctx.close();
        stream = null; ctx = null; analyser = null; segmento = null;
        overlay.classList.remove('abierta', 'hablando');
        busy = false;
        estado = 'inactiva';
        if (typeof aviso === 'function') aviso('Llamada terminada · ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
    }

    // ---------- Acciones rápidas en lenguaje natural ----------
    if (typeof elegirComando === 'function') {
        const original = elegirComando;
        window.elegirComando = function (tipo) {
            if (tipo === 'evento' || tipo === 'nota') {
                if (typeof cerrarComandos === 'function') cerrarComandos();
                input.value = tipo === 'evento' ? 'Agendame ' : 'Anotá en mis notas: ';
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                return;
            }
            return original(tipo);
        };
        document.querySelectorAll('.comando-opcion').forEach(b => {
            const oc = b.getAttribute('onclick') || '';
            const ayuda = b.querySelector('.comando-ayuda');
            if (!ayuda) return;
            if (oc.indexOf("'evento'") >= 0) ayuda.textContent = 'Ej: "agendame mañana 4 pm llamar al proveedor"';
            if (oc.indexOf("'nota'") >= 0) ayuda.textContent = 'Se guarda en tu Google Doc "Notas de Lunara"';
        });
    }
})();