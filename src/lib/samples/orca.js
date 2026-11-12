
(function() {
    const sceneWrapper = document.getElementById('sceneWrapper');
    const oceanScene = document.getElementById('oceanScene');
    const orcaJumpLayer = document.getElementById('orcaJumpLayer');
    const orcaGlowGroup = document.getElementById('orcaGlowGroup');
    const orcaMouseLayer = document.getElementById('orcaMouseLayer');
    const orcaDragLayer = document.getElementById('orcaDragLayer');
    const clickHint = document.getElementById('clickHint');
    const zzzContainer = document.getElementById('zzzContainer');
    const bubbleElements = document.querySelectorAll('.bubble');
    const bgmToggle = document.getElementById('bgmToggle');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeLabel = document.getElementById('volumeLabel');
    const svgEl = oceanScene.querySelector('svg');

    let isJumping = false, isFeeding = false, isDragging = false;
    let audioCtx = null;
    let tailClickTimes = [];
    const TAIL_ANGRY_THRESHOLD = 3;
    const TAIL_ANGRY_WINDOW = 2500;
    let isAngry = false;
    let angryTimer = null;
    let angrySymbolInterval = null;
    const ANGRY_DURATION = 1750;
    let sleepTimer = null, isSleeping = false;
    const SLEEP_TIMEOUT = 10000;
    let musicNodes = null, musicStarted = false;
    let bgmEnabled = true;
    let bgmVolume = 0.07;
    let cricketNodes = null;
    let pointerState = null;
    let recentJumps = [];
    let recentFeeds = [];

    const MESSAGES = {
        jump: ['嘿咻！🐋', '跳一个～', '看我！', '(๑•̀ㅂ•́)و✧', '咻——', '蹦！'],
        jumpRepeat: ['又跳～', '停不下来！', '跳跳跳！', '(๑>ᴗ<๑)', '累不累呀'],
        jumpAngry: ['哼！', '别烦我', '💢'],
        dorsal: ['最喜欢你摸这里 ❤', '痒痒的～', '再摸摸 (๑´ω`๑)', '好舒服～', '❤(ӦｖӦ｡)', '嘿嘿～'],
        dorsalAngry: ['走开！', '不要碰', '(╬ Ò﹏Ó)'],
        belly: ['啊呜～', '好吃！(๑´ڡ`๑)', '谢谢！', 'yummy~', '还想吃～', '美味！'],
        bellyFull: ['有点饱了…', '嗝～ (´-ω-`)', '够了啦', '吃不下了…', '别再喂了～'],
        bellyAngry: ['勉强吃一口', '哼', '下次不要了'],
        angryFirst: ['别戳了！', '生气了！💢', '(╬ Ò﹏Ó)', '真的生气了！', '哼！！'],
        angryMore: ['更生气了', '你完了 🔥', '不听不听', '৻( ˃̶͈◞◟˂̶͈ )'],
        calm: ['呼…', '算了 (￣▽￣)', '下次不许了', '原谅你了～'],
        drag: ['哇啊——', '放我下来', '去哪？', '晕…', '(ﾟДﾟ;)', '挣扎中…'],
        release: ['呼～', '回来了 (｡•́︿•̀｡)', '终于', '哎哟～'],
        sleep: ['困了…', 'Zzz', '晚安… (｡-ω-)', '打个盹'],
        wake: ['唔…', '谁啊…', '再睡一会', '(￣o￣) . z Z'],
        bubble: ['啵', '啪', '戳到啦', '(๑>ᴗ<๑)', '泡泡～']
    };

    const lastMsgCache = new Map();
    function pickMessage(poolKey) {
        const pool = MESSAGES[poolKey];
        if (!pool || pool.length === 0) return null;
        const now = Date.now();
        const last = lastMsgCache.get(poolKey);
        let text;
        let attempts = 0;
        do {
            text = pool[Math.floor(Math.random() * pool.length)];
            attempts++;
        } while (last && last.text === text && now - last.time < 1500 && attempts < 5);
        lastMsgCache.set(poolKey, { text, time: now });
        return text;
    }

    const activeCards = [];
    const MAX_CARDS = 2;

    function getScreenPos(vx, vy) {
        const svgRect = svgEl.getBoundingClientRect();
        const wrapperRect = sceneWrapper.getBoundingClientRect();
        const scaleX = svgRect.width / 190;
        const scaleY = svgRect.height / 190;
        return {
            x: (svgRect.left - wrapperRect.left) + vx * scaleX,
            y: (svgRect.top - wrapperRect.top) + vy * scaleY
        };
    }

    function dismissCard(card) {
        if (!card || !card.parentNode) return;
        const idx = activeCards.indexOf(card);
        if (idx !== -1) activeCards.splice(idx, 1);
        if (card.classList.contains('dismissing')) return;
        card.classList.add('dismissing');
        setTimeout(() => {
            if (card.parentNode) card.remove();
        }, 650);
    }

    function showSpeechCard(text, vx, vy, options = {}) {
        if (!text) return;
        const { isAngry: angry = false, offsetY = -22 } = options;
        while (activeCards.length >= MAX_CARDS) {
            dismissCard(activeCards.shift());
        }
        const pos = getScreenPos(vx, vy);
        const card = document.createElement('div');
        card.className = 'speech-card' + (angry ? ' angry' : '');
        card.style.left = pos.x + 'px';
        card.style.top = (pos.y + offsetY) + 'px';
        card.style.transform = 'translate(-50%, -100%)';
        const rot = (Math.random() - 0.5) * 8;
        card.style.setProperty('--rot', rot.toFixed(2) + 'deg');
        const inner = document.createElement('div');
        inner.className = 'speech-card-inner';
        inner.textContent = text;
        card.appendChild(inner);
        sceneWrapper.appendChild(card);
        activeCards.push(card);
        const duration = 2200 + Math.random() * 600;
        setTimeout(() => dismissCard(card), duration);
    }

    function getAudioContext() {
        if (!audioCtx || audioCtx.state === 'closed') audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
    }

    function updateBGMVolume() {
        if (musicNodes && musicNodes.masterGain) {
            const targetGain = bgmEnabled ? bgmVolume : 0;
            musicNodes.masterGain.gain.linearRampToValueAtTime(targetGain, musicNodes.ctx.currentTime + 0.3);
        }
    }

    function startBackgroundMusic() {
        if (musicStarted) return;
        musicStarted = true;
        try {
            const ctx = getAudioContext();
            const masterGain = ctx.createGain();
            masterGain.gain.value = 0;
            masterGain.connect(ctx.destination);
            masterGain.gain.linearRampToValueAtTime(bgmVolume, ctx.currentTime + 2);
            let melodyTimer = null;
            function playMelodyNote() {
                if (!musicStarted) { melodyTimer = setTimeout(playMelodyNote, 2000 + Math.random() * 3000); return; }
                try {
                    const noteFreq = [330, 392, 440, 523, 587, 659, 784][Math.floor(Math.random() * 7)];
                    const noteOsc = ctx.createOscillator();
                    const noteGain = ctx.createGain();
                    noteOsc.type = 'sine';
                    noteOsc.frequency.value = noteFreq;
                    noteGain.gain.setValueAtTime(0, ctx.currentTime);
                    noteGain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.3);
                    noteGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5);
                    noteOsc.connect(noteGain);
                    noteGain.connect(masterGain);
                    noteOsc.start(ctx.currentTime);
                    noteOsc.stop(ctx.currentTime + 2.8);
                } catch(e) {}
                melodyTimer = setTimeout(playMelodyNote, 2500 + Math.random() * 4000);
            }
            melodyTimer = setTimeout(playMelodyNote, 3000);
            musicNodes = { masterGain, melodyTimer, ctx };
        } catch(e) { musicStarted = false; }
    }

    function initMusicOnInteraction() { if (!musicStarted) startBackgroundMusic(); }

    function playDolphinSound() { try { const ctx = getAudioContext(); const now = ctx.currentTime; const o1=ctx.createOscillator(),g1=ctx.createGain(); o1.type='sine'; o1.frequency.setValueAtTime(2800,now); o1.frequency.exponentialRampToValueAtTime(5800,now+0.12); o1.frequency.exponentialRampToValueAtTime(3200,now+0.28); o1.frequency.setValueAtTime(4200,now+0.32); o1.frequency.exponentialRampToValueAtTime(2000,now+0.45); g1.gain.setValueAtTime(0,now); g1.gain.linearRampToValueAtTime(0.22,now+0.03); g1.gain.linearRampToValueAtTime(0.14,now+0.2); g1.gain.linearRampToValueAtTime(0.06,now+0.38); g1.gain.linearRampToValueAtTime(0,now+0.48); o1.connect(g1); g1.connect(ctx.destination); o1.start(now); o1.stop(now+0.5); const o2=ctx.createOscillator(),g2=ctx.createGain(); o2.type='sine'; o2.frequency.setValueAtTime(3500,now+0.16); o2.frequency.exponentialRampToValueAtTime(6500,now+0.25); o2.frequency.exponentialRampToValueAtTime(3000,now+0.38); g2.gain.setValueAtTime(0,now+0.16); g2.gain.linearRampToValueAtTime(0.16,now+0.19); g2.gain.linearRampToValueAtTime(0.08,now+0.32); g2.gain.linearRampToValueAtTime(0,now+0.42); o2.connect(g2); g2.connect(ctx.destination); o2.start(now+0.16); o2.stop(now+0.45); } catch(e){} }
    function playPopSound() { try { const ctx=getAudioContext(); const now=ctx.currentTime; const o=ctx.createOscillator(),g=ctx.createGain(); o.type='sine'; o.frequency.setValueAtTime(1800,now); o.frequency.exponentialRampToValueAtTime(400,now+0.08); g.gain.setValueAtTime(0.12,now); g.gain.exponentialRampToValueAtTime(0.001,now+0.1); o.connect(g); g.connect(ctx.destination); o.start(now); o.stop(now+0.12); } catch(e){} }
    function playFeedSound() { try { const ctx=getAudioContext(); const now=ctx.currentTime; const o=ctx.createOscillator(),g=ctx.createGain(); o.type='sine'; o.frequency.setValueAtTime(1600,now); o.frequency.exponentialRampToValueAtTime(2400,now+0.1); o.frequency.setValueAtTime(2000,now+0.2); o.frequency.exponentialRampToValueAtTime(1400,now+0.35); g.gain.setValueAtTime(0,now); g.gain.linearRampToValueAtTime(0.15,now+0.03); g.gain.linearRampToValueAtTime(0.08,now+0.2); g.gain.linearRampToValueAtTime(0,now+0.4); o.connect(g); g.connect(ctx.destination); o.start(now); o.stop(now+0.42); } catch(e){} }
    function playAngrySound() { try { const ctx=getAudioContext(); const now=ctx.currentTime; const o=ctx.createOscillator(),g=ctx.createGain(); o.type='sawtooth'; o.frequency.setValueAtTime(200,now); o.frequency.exponentialRampToValueAtTime(80,now+0.4); g.gain.setValueAtTime(0,now); g.gain.linearRampToValueAtTime(0.15,now+0.01); g.gain.exponentialRampToValueAtTime(0.001,now+0.45); o.connect(g); g.connect(ctx.destination); o.start(now); o.stop(now+0.5); } catch(e){} }

    function startCricketSound() {
        if (cricketNodes) return;
        try {
            const ctx = getAudioContext();
            const masterGain = ctx.createGain();
            masterGain.gain.value = 0;
            masterGain.connect(ctx.destination);
            masterGain.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 1.5);
            let cricketInterval = null;
            function chirp() {
                if (!cricketNodes) return;
                try {
                    const now = ctx.currentTime;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = 3800 + Math.random() * 1800;
                    gain.gain.setValueAtTime(0, now);
                    gain.gain.linearRampToValueAtTime(0.06, now + 0.01);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
                    osc.connect(gain);
                    gain.connect(masterGain);
                    osc.start(now);
                    osc.stop(now + 0.08);
                } catch(e) {}
                cricketInterval = setTimeout(chirp, 250 + Math.random() * 500);
            }
            cricketInterval = setTimeout(chirp, 300);
            cricketNodes = { masterGain, cricketInterval, ctx };
        } catch(e) { cricketNodes = null; }
    }

    function stopCricketSound() {
        if (!cricketNodes) return;
        try {
            clearTimeout(cricketNodes.cricketInterval);
            cricketNodes.masterGain.gain.linearRampToValueAtTime(0, cricketNodes.ctx.currentTime + 0.8);
            setTimeout(() => {
                if (cricketNodes) { cricketNodes.masterGain.disconnect(); cricketNodes = null; }
            }, 1000);
        } catch(e) { cricketNodes = null; }
    }

    function spawnHearts(originX, originY) {
        const wrapperRect = sceneWrapper.getBoundingClientRect();
        const x = originX !== undefined ? originX : wrapperRect.width * 0.52;
        const y = originY !== undefined ? originY : wrapperRect.height * 0.25;
        for(let i=0;i<3;i++){
            const h = document.createElement('div'); h.className='heart-particle';
            const s = 8+Math.random()*10, dx=(Math.random()-0.5)*60, rise=50+Math.random()*50, rot=(Math.random()-0.5)*40, dur=1.5+Math.random(), delay=Math.random()*0.3;
            h.style.cssText = `left:${x}px; top:${y}px; --hSize:${s}px; --hDriftX:${dx}px; --hRise:${rise}px; --hRot:${rot}deg; --hDur:${dur}s; --hDelay:${delay}s;`;
            h.innerHTML = `<div class="heart-shape" style="width:${s}px;height:${s}px;"></div>`;
            sceneWrapper.appendChild(h);
            setTimeout(()=>{ if(h.parentNode) h.remove(); }, (dur+delay)*1000+200);
        }
    }

    function spawnAngrySymbol() {
        const wrapperRect = sceneWrapper.getBoundingClientRect();
        const sx = wrapperRect.width * 0.55, sy = wrapperRect.height * 0.24;
        const sym = document.createElement('div'); sym.className='angry-symbol';
        sym.textContent = '💢';
        sym.style.cssText = `left:${sx + (Math.random()-0.5)*50}px; top:${sy + (Math.random()-0.5)*15}px; animation-delay:${Math.random()*0.3}s;`;
        sceneWrapper.appendChild(sym);
        setTimeout(()=>{ if(sym.parentNode) sym.remove(); }, 1000);
    }

    function popBubble(b) {
        if(b.classList.contains('popped')) return;
        b.classList.add('popped');
        playPopSound();
        const cx = parseFloat(b.getAttribute('cx'));
        const cy = parseFloat(b.getAttribute('cy'));
        const msg = pickMessage('bubble');
        showSpeechCard(msg, cx, cy, { offsetY: -18 });
        setTimeout(()=>{ b.classList.remove('popped'); }, 2000);
    }

    function getOrcaPart(vx, vy) {
        if (vx > 112 && vy < 98) return 'tail';
        if (Math.pow((vx - 104) / 24, 2) + Math.pow((vy - 55) / 22, 2) < 1) return 'dorsal';
        if (Math.pow((vx - 60) / 28, 2) + Math.pow((vy - 135) / 22, 2) < 1) return 'belly';
        return 'body';
    }

    function isOnOrca(vx, vy) {
        return Math.pow((vx - 90) / 66, 2) + Math.pow((vy - 100) / 58, 2) < 1.2;
    }

    function handleTailClick() {
        initMusicOnInteraction();
        const now = Date.now();
        tailClickTimes.push(now);
        tailClickTimes = tailClickTimes.filter(t => now - t < TAIL_ANGRY_WINDOW);
        if (tailClickTimes.length >= TAIL_ANGRY_THRESHOLD && !isAngry) {
            triggerAngry();
        } else if (isAngry) {
            clearTimeout(angryTimer);
            angryTimer = setTimeout(calmDown, ANGRY_DURATION);
            spawnAngrySymbol();
            playAngrySound();
            const msg = pickMessage('angryMore');
            showSpeechCard(msg, 155, 72, { isAngry: true, offsetY: -20 });
        }
    }

    function handleDorsalClick() {
        initMusicOnInteraction();
        if (isJumping || isFeeding) return;
        triggerJump();
        const rect = sceneWrapper.getBoundingClientRect();
        spawnHearts(rect.width * 0.56, rect.height * 0.28);
        const msg = pickMessage(isAngry ? 'dorsalAngry' : 'dorsal');
        showSpeechCard(msg, 100, 48, { isAngry, offsetY: -18 });
    }

    function handleBellyClick() {
        initMusicOnInteraction();
        if (isFeeding || isJumping || isDragging) return;
        spawnFish();
    }

    function handleBodyClick() {
        initMusicOnInteraction();
        if (isJumping || isFeeding || isDragging) return;
        triggerJump();
    }

    function handleTapAt(clientX, clientY) {
        for (const b of bubbleElements) {
            if (b.classList.contains('popped')) continue;
            const r = b.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const minRadius = 16;
            const radius = Math.max(r.width, minRadius);
            if (Math.hypot(clientX - cx, clientY - cy) < radius * 1.5) {
                popBubble(b);
                return;
            }
        }

        const rect = svgEl.getBoundingClientRect();
        const vx = (clientX - rect.left) / rect.width * 190;
        const vy = (clientY - rect.top) / rect.height * 190;

        if (!isOnOrca(vx, vy)) return;

        const part = getOrcaPart(vx, vy);
        if (part === 'tail') handleTailClick();
        else if (part === 'dorsal') handleDorsalClick();
        else if (part === 'belly') handleBellyClick();
        else handleBodyClick();
    }

    // ===== 指针事件 =====
    function onPointerDown(e) {
        if (isJumping || isFeeding || isSleeping) return;
        if (e.button !== undefined && e.button !== 0) return;
        pointerState = {
            startX: e.clientX,
            startY: e.clientY,
            startTime: Date.now(),
            isDragging: false,
            pointerId: e.pointerId
        };
        initMusicOnInteraction();
        onUserInteraction();
    }

    function onPointerMove(e) {
        if (e.pointerType === 'mouse' && !isJumping && !isFeeding && !isDragging && !isSleeping) {
            const rect = oceanScene.getBoundingClientRect();
            const mx = e.clientX - rect.left - rect.width / 2;
            const my = e.clientY - rect.top - rect.height / 2;
            orcaMouseLayer.style.transition = 'transform 0.35s ease-out';
            orcaMouseLayer.style.transform = `rotate(${Math.atan2(mx, -my) * (180 / Math.PI) * 0.35}deg)`;
        }

        if (!pointerState || pointerState.pointerId !== e.pointerId) return;

        const dx = e.clientX - pointerState.startX;
        const dy = e.clientY - pointerState.startY;
        const dist = Math.hypot(dx, dy);

        if (!pointerState.isDragging && dist > 8) {
            pointerState.isDragging = true;
            isDragging = true;
            orcaDragLayer.style.transition = 'none';
            oceanScene.style.cursor = 'grabbing';
            // 清除鼠标追踪旋转
            orcaMouseLayer.style.transition = 'transform 0.25s ease-out';
            orcaMouseLayer.style.transform = '';
            // 应用挣扎动态
            orcaMouseLayer.classList.add('is-dragging');
            if (isSleeping) wakeUp();
            const msg = pickMessage('drag');
            const rect = oceanScene.getBoundingClientRect();
            const vx = (e.clientX - rect.left) / rect.width * 190;
            const vy = (e.clientY - rect.top) / rect.height * 190;
            showSpeechCard(msg, Math.max(30, Math.min(160, vx)), Math.max(30, Math.min(160, vy)), { offsetY: -25 });
        }

        if (pointerState.isDragging) {
            orcaDragLayer.setAttribute('transform', `translate(${dx * 0.7}, ${dy * 0.7})`);
        }
    }

    function onPointerUp(e) {
        if (!pointerState || pointerState.pointerId !== e.pointerId) return;
        const dx = e.clientX - pointerState.startX;
        const dy = e.clientY - pointerState.startY;
        const dist = Math.hypot(dx, dy);
        const duration = Date.now() - pointerState.startTime;
        const wasDragging = pointerState.isDragging;
        pointerState = null;

        if (wasDragging) {
            isDragging = false;
            // 移除挣扎动态
            orcaMouseLayer.classList.remove('is-dragging');
            orcaDragLayer.style.transition = 'transform 0.6s cubic-bezier(0.34,1.56,0.64,1)';
            orcaDragLayer.setAttribute('transform', 'translate(0,0)');
            oceanScene.style.cursor = 'grab';
            const msg = pickMessage('release');
            showSpeechCard(msg, 95, 90, { offsetY: -25 });
            resetSleepTimer();
            return;
        }

        if (dist < 12 && duration < 800) {
            handleTapAt(e.clientX, e.clientY);
        }
    }

    function onPointerCancel(e) {
        if (!pointerState) return;
        if (pointerState.isDragging) {
            isDragging = false;
            orcaMouseLayer.classList.remove('is-dragging');
            orcaDragLayer.style.transition = 'transform 0.6s cubic-bezier(0.34,1.56,0.64,1)';
            orcaDragLayer.setAttribute('transform', 'translate(0,0)');
            oceanScene.style.cursor = 'grab';
        }
        pointerState = null;
    }

    svgEl.addEventListener('pointerdown', onPointerDown);
    svgEl.addEventListener('pointermove', onPointerMove);
    svgEl.addEventListener('pointerup', onPointerUp);
    svgEl.addEventListener('pointercancel', onPointerCancel);
    svgEl.addEventListener('pointerleave', (e) => {
        if (pointerState && !pointerState.isDragging) pointerState = null;
    });

    oceanScene.addEventListener('mouseleave', () => {
        if (isJumping || isFeeding || isDragging || isSleeping) return;
        orcaMouseLayer.style.transition = 'transform 0.6s ease-out';
        orcaMouseLayer.style.transform = '';
    });

    document.addEventListener('keydown', (e) => {
        initMusicOnInteraction();
        if (e.code === 'Space' && !isJumping && !isFeeding && !isDragging) {
            e.preventDefault();
            handleBodyClick();
        }
        if (e.code === 'KeyF' && !isJumping && !isFeeding && !isDragging) {
            e.preventDefault();
            handleBellyClick();
        }
    });

    function triggerJump() {
        if (isJumping || isFeeding || isDragging) return;
        isJumping = true;

        const now = Date.now();
        recentJumps = recentJumps.filter(t => now - t < 3000);
        recentJumps.push(now);
        const isRepeat = recentJumps.length >= 3;

        clickHint.style.opacity = '0';
        oceanScene.classList.add('jumping-scene');
        if (!isAngry) orcaGlowGroup.classList.add('jumping-glow');
        orcaJumpLayer.classList.remove('jumping', 'jumping-feeding');
        void orcaJumpLayer.offsetWidth;
        orcaJumpLayer.classList.add('jumping');
        playDolphinSound();

        const msg = pickMessage(isAngry ? 'jumpAngry' : (isRepeat ? 'jumpRepeat' : 'jump'));
        showSpeechCard(msg, 95, 68, { isAngry, offsetY: -28 });

        setTimeout(() => {
            orcaJumpLayer.classList.remove('jumping');
            if (!isAngry) orcaGlowGroup.classList.remove('jumping-glow');
            oceanScene.classList.remove('jumping-scene');
            isJumping = false;
            clickHint.style.opacity = '';
            resetSleepTimer();
        }, 1250);
    }

    function spawnFish() {
        if (isFeeding || isJumping || isDragging) return;
        isFeeding = true;
        isJumping = true;

        const now = Date.now();
        recentFeeds = recentFeeds.filter(t => now - t < 5000);
        recentFeeds.push(now);
        const isFull = recentFeeds.length >= 3;

        const msg = pickMessage(isAngry ? 'bellyAngry' : (isFull ? 'bellyFull' : 'belly'));
        showSpeechCard(msg, 40, 80, { isAngry, offsetY: -20 });

        const wrapperRect = sceneWrapper.getBoundingClientRect();
        const fish = document.createElement('div');
        fish.className = 'fish-snack';
        fish.innerHTML = '<div class="fish-wiggle"><div class="fish-body"></div></div>';
        fish.style.left = wrapperRect.width * 0.08 + 'px';
        fish.style.top = wrapperRect.height * 0.08 + 'px';
        sceneWrapper.appendChild(fish);
        orcaJumpLayer.classList.remove('jumping', 'jumping-feeding');
        void orcaJumpLayer.offsetWidth;
        orcaJumpLayer.classList.add('jumping-feeding');
        oceanScene.classList.add('jumping-scene');
        if (!isAngry) orcaGlowGroup.classList.add('jumping-glow');
        const tx = wrapperRect.width * 0.188, ty = wrapperRect.height * 0.437;
        requestAnimationFrame(() => {
            fish.style.left = tx + 'px';
            fish.style.top = ty + 'px';
        });
        setTimeout(() => {
            fish.classList.add('eaten');
            playFeedSound();
            const toast = document.createElement('div');
            toast.className = 'feed-toast';
            toast.textContent = isAngry ? ['哼！', '😤', '勉强吃掉…'][Math.floor(Math.random() * 3)] : ['好吃！', 'yummy~', '再来一条！', '谢谢！'][Math.floor(Math.random() * 4)];
            toast.style.cssText = `left:${tx}px; top:${ty - 15}px;`;
            sceneWrapper.appendChild(toast);
            setTimeout(() => { toast.remove(); }, 1700);
        }, 900);
        setTimeout(() => {
            orcaJumpLayer.classList.remove('jumping-feeding');
            if (!isAngry) orcaGlowGroup.classList.remove('jumping-glow');
            oceanScene.classList.remove('jumping-scene');
            fish.remove();
            isJumping = false;
            isFeeding = false;
            resetSleepTimer();
        }, 1300);
    }

    function triggerAngry() {
        isAngry = true;
        document.documentElement.style.setProperty('--orca-body', '#a57a7a');
        orcaGlowGroup.classList.add('angry-glow');
        orcaMouseLayer.classList.add('angry-shake');
        playAngrySound();
        spawnAngrySymbol();
        angrySymbolInterval = setInterval(spawnAngrySymbol, 800);
        angryTimer = setTimeout(calmDown, ANGRY_DURATION);
        clickHint.textContent = '💢 别戳尾巴了！';
        clickHint.classList.add('angry-hint');
        const msg = pickMessage('angryFirst');
        showSpeechCard(msg, 155, 72, { isAngry: true, offsetY: -20 });
    }

    function calmDown() {
        isAngry = false;
        tailClickTimes = [];
        document.documentElement.style.setProperty('--orca-body', '#6b83a0');
        orcaGlowGroup.classList.remove('angry-glow');
        orcaMouseLayer.classList.remove('angry-shake');
        if (angryTimer) clearTimeout(angryTimer);
        if (angrySymbolInterval) clearInterval(angrySymbolInterval);
        clickHint.textContent = '🐋 身体弹跳 · 背鳍爱心 · 腹部喂食 · 连戳尾鳍生气';
        clickHint.classList.remove('angry-hint');
        const msg = pickMessage('calm');
        showSpeechCard(msg, 95, 68, { offsetY: -25 });
    }

    function startSleep() {
        if (isSleeping || isJumping || isFeeding || isDragging || isAngry) return;
        isSleeping = true;
        oceanScene.classList.add('sleeping');
        zzzContainer.style.opacity = '1';
        startCricketSound();
        const msg = pickMessage('sleep');
        showSpeechCard(msg, 95, 60, { offsetY: -25 });
    }

    function wakeUp() {
        if (!isSleeping) return;
        isSleeping = false;
        oceanScene.classList.remove('sleeping');
        zzzContainer.style.opacity = '0';
        stopCricketSound();
        const msg = pickMessage('wake');
        showSpeechCard(msg, 95, 60, { offsetY: -25 });
        resetSleepTimer();
    }

    function resetSleepTimer() {
        if (sleepTimer) clearTimeout(sleepTimer);
        if (isSleeping) wakeUp();
        sleepTimer = setTimeout(startSleep, SLEEP_TIMEOUT);
    }

    function onUserInteraction() {
        if (!isDragging) resetSleepTimer();
    }

    bgmToggle.addEventListener('click', () => {
        bgmEnabled = !bgmEnabled;
        if (bgmEnabled) {
            bgmToggle.classList.remove('muted');
            bgmToggle.textContent = '🎵';
        } else {
            bgmToggle.classList.add('muted');
            bgmToggle.textContent = '🔇';
        }
        updateBGMVolume();
        initMusicOnInteraction();
    });

    volumeSlider.addEventListener('input', () => {
        const val = parseInt(volumeSlider.value);
        bgmVolume = val / 100 * 0.1;
        volumeLabel.textContent = val + '%';
        updateBGMVolume();
        initMusicOnInteraction();
    });


    /* ========== 海底信箱 · 留言板 ========== */
    (function () {
        const SUPA_URL = 'https://mzspntoddxwikwhfbfou.supabase.co';
        const SUPA_KEY = 'sb_publishable_CTmOy9gYK70JRNPdr8Rmig_xCNIYEKr';
        const TABLE = 'deepbluebook';
        const PAGE_SIZE = 20;
        const MAX_PAGES = 2;          // 最多显示 2 页 = 40 条，防刷屏
        const THROTTLE_MS = 8000;     // 同一浏览器 8 秒内只能投一条
        const NICK_KEY = 'orca_board_nick';
        const LAST_POST_KEY = 'orca_board_last_post';

        const $ = (id) => document.getElementById(id);
        const drawer = $('boardDrawer');
        const scrim = $('boardScrim');
        const trigger = $('boardTrigger');
        const closeBtn = $('boardClose');
        const form = $('boardForm');
        const nickEl = $('boardNick');
        const textEl = $('boardText');
        const countEl = $('boardCount');
        const sendBtn = $('boardSend');
        const statusEl = $('boardStatus');
        const listEl = $('boardList');
        const prevBtn = $('boardPrev');
        const nextBtn = $('boardNext');
        const pageInfo = $('boardPageInfo');
        const pager = $('boardPager');

        if (!drawer || !trigger) return;

        let currentPage = 0;
        let totalRows = 0;
        let loading = false;
        let opened = false;

        function setStatus(msg, kind) {
            statusEl.textContent = msg || '';
            statusEl.className = 'board-status' + (kind ? ' ' + kind : '');
        }

        function fmtTime(iso) {
            if (!iso) return '';
            const t = new Date(iso);
            if (isNaN(t.getTime())) return '';
            const diff = Date.now() - t.getTime();
            const min = Math.floor(diff / 60000);
            if (min < 1) return '刚刚';
            if (min < 60) return min + ' 分钟前';
            const hr = Math.floor(min / 60);
            if (hr < 24) return hr + ' 小时前';
            const day = Math.floor(hr / 24);
            if (day === 1) return '昨天';
            if (day < 7) return day + ' 天前';
            const mm = String(t.getMonth() + 1).padStart(2, '0');
            const dd = String(t.getDate()).padStart(2, '0');
            return mm + '-' + dd;
        }

        function renderEmpty() {
            listEl.innerHTML = '';
            const box = document.createElement('div');
            box.className = 'board-empty';
            const em = document.createElement('span');
            em.className = 'board-empty-emoji';
            em.textContent = '🌊';
            box.appendChild(em);
            box.appendChild(document.createTextNode('海底还很安静，成为第一个写信的人吧'));
            listEl.appendChild(box);
        }

        function renderList(rows) {
            listEl.innerHTML = '';
            if (!rows || rows.length === 0) {
                renderEmpty();
                return;
            }
            rows.forEach(function (row, i) {
                const card = document.createElement('div');
                card.className = 'board-card';
                const rot = ((i * 37) % 5 - 2) * 0.28;
                card.style.setProperty('--rot', rot.toFixed(2) + 'deg');
                card.style.animationDelay = (i * 0.03).toFixed(2) + 's';

                const head = document.createElement('div');
                head.className = 'board-card-head';

                const nick = document.createElement('span');
                nick.className = 'board-card-nick';
                nick.textContent = (row.nickname && String(row.nickname).trim()) || '匿名鲸鱼';

                const time = document.createElement('span');
                time.className = 'board-card-time';
                time.textContent = fmtTime(row.created_at);

                head.appendChild(nick);
                head.appendChild(time);

                const body = document.createElement('div');
                body.className = 'board-card-text';
                body.textContent = row.content || '';

                card.appendChild(head);
                card.appendChild(body);
                listEl.appendChild(card);
            });
        }

        function renderPager() {
            const pages = Math.max(1, Math.min(Math.ceil(totalRows / PAGE_SIZE), MAX_PAGES));
            if (pages <= 1) {
                pager.style.display = 'none';
                return;
            }
            pager.style.display = 'flex';
            pageInfo.textContent = (currentPage + 1) + ' / ' + pages;
            prevBtn.disabled = currentPage <= 0;
            nextBtn.disabled = currentPage >= pages - 1;
        }

        async function loadPage(page) {
            if (loading) return;
            loading = true;
            setStatus('正在打捞海底的信…');
            try {
                const offset = page * PAGE_SIZE;
                const url = SUPA_URL + '/rest/v1/' + TABLE +
                    '?select=id,nickname,content,created_at' +
                    '&order=created_at.desc&limit=' + PAGE_SIZE + '&offset=' + offset;
                const res = await fetch(url, {
                    headers: {
                        apikey: SUPA_KEY,
                        Authorization: 'Bearer ' + SUPA_KEY,
                        Prefer: 'count=exact'
                    }
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);

                const range = res.headers.get('content-range') || '';
                const m = range.match(/\/(\d+)$/);
                if (m) totalRows = parseInt(m[1], 10);

                const rows = await res.json();
                if (!Array.isArray(rows)) throw new Error('bad payload');

                currentPage = page;
                renderList(rows);
                renderPager();
                setStatus(totalRows > 0 ? '共 ' + totalRows + ' 封信' : '');
            } catch (err) {
                setStatus('海底信号不太好，稍后再试试', 'error');
                renderEmpty();
                pager.style.display = 'none';
            } finally {
                loading = false;
            }
        }

        function openBoard() {
            if (opened) return;
            opened = true;
            drawer.classList.add('open');
            scrim.classList.add('open');
            loadPage(0);
        }

        function closeBoard() {
            if (!opened) return;
            opened = false;
            drawer.classList.remove('open');
            scrim.classList.remove('open');
        }

        // 昵称记忆
        try {
            const saved = localStorage.getItem(NICK_KEY);
            if (saved) nickEl.value = saved;
        } catch (e) {}

        function updateCount() {
            const len = textEl.value.length;
            countEl.textContent = len + ' / 200';
            countEl.className = 'board-count' + (len > 180 ? ' warn' : '');
        }
        textEl.addEventListener('input', updateCount);
        updateCount();

        // 提交
        form.addEventListener('submit', async function (e) {
            e.preventDefault();

            const content = textEl.value.trim();
            const nickname = nickEl.value.trim();

            if (!content) {
                setStatus('先写点什么再投进海里吧', 'error');
                textEl.focus();
                return;
            }
            if (content.length > 200) {
                setStatus('太长了，200 字以内哦', 'error');
                return;
            }

            const now = Date.now();
            let last = 0;
            try { last = parseInt(localStorage.getItem(LAST_POST_KEY) || '0', 10); } catch (e2) {}
            const wait = THROTTLE_MS - (now - last);
            if (wait > 0) {
                setStatus('慢一点，' + Math.ceil(wait / 1000) + ' 秒后再投', 'error');
                return;
            }

            sendBtn.disabled = true;
            setStatus('正在投递…');

            try {
                const res = await fetch(SUPA_URL + '/rest/v1/' + TABLE, {
                    method: 'POST',
                    headers: {
                        apikey: SUPA_KEY,
                        Authorization: 'Bearer ' + SUPA_KEY,
                        'Content-Type': 'application/json',
                        Prefer: 'return=minimal'
                    },
                    body: JSON.stringify({
                        nickname: nickname || '匿名鲸鱼',
                        content: content
                    })
                });

                if (!res.ok) {
                    let detail = '';
                    try {
                        const j = await res.json();
                        detail = j.message || '';
                    } catch (e3) {}
                    throw new Error(detail || ('HTTP ' + res.status));
                }

                try {
                    localStorage.setItem(LAST_POST_KEY, String(now));
                    if (nickname) localStorage.setItem(NICK_KEY, nickname);
                } catch (e4) {}

                textEl.value = '';
                updateCount();
                setStatus('投进海里啦 🌊 谢谢你的信', 'ok');
                showSpeechCard('收到信啦～💌', 95, 62, { offsetY: -26 });

                setTimeout(function () { loadPage(0); }, 600);
            } catch (err) {
                const msg = String(err && err.message ? err.message : err);
                if (msg.indexOf('row-level security') >= 0 || msg.indexOf('42501') >= 0) {
                    setStatus('信箱还没开张（数据库权限未配置）', 'error');
                } else {
                    setStatus('投递失败，稍后再试试', 'error');
                }
            } finally {
                setTimeout(function () { sendBtn.disabled = false; }, 1200);
            }
        });

        trigger.addEventListener('click', openBoard);
        var envelope = document.getElementById('boardEnvelope');
        if (envelope) envelope.addEventListener('click', openBoard);
        closeBtn.addEventListener('click', closeBoard);
        scrim.addEventListener('click', closeBoard);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && opened) closeBoard();
        });

        prevBtn.addEventListener('click', function () {
            if (currentPage > 0) loadPage(currentPage - 1);
        });
        nextBtn.addEventListener('click', function () {
            const pages = Math.max(1, Math.min(Math.ceil(totalRows / PAGE_SIZE), MAX_PAGES));
            if (currentPage < pages - 1) loadPage(currentPage + 1);
        });
    })();

    resetSleepTimer();
    console.log('🐋 纸雕虎鲸海底世界已就绪！');
    console.log('   🎬 挣扎动态：拖拽/弹飞时眼睛挤压、鱼鳍扑腾');
    console.log('   💬 互动消息字卡已上线');
})();
