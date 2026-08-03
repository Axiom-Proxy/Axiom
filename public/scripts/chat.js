const trigger = document.getElementById('dropdownTrigger');
        const panel = document.getElementById('dropdownPanel');
        const label = document.getElementById('dropdownLabel');
        const options = panel.querySelectorAll('.dropdown-option');

        trigger.addEventListener('click', () => {
            const isOpen = panel.classList.contains('open');
            panel.classList.toggle('open', !isOpen);
            trigger.classList.toggle('open', !isOpen);
        });

        options.forEach(opt => {
            opt.addEventListener('click', () => {
                options.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                label.textContent = opt.dataset.label;
                panel.classList.remove('open');
                trigger.classList.remove('open');
            });
        });

        document.addEventListener('click', e => {
            if (!document.getElementById('modelDropdown').contains(e.target)) {
                panel.classList.remove('open');
                trigger.classList.remove('open');
            }
        });

let genlock = false
        let chatHistory = []
        let pendingImages = [] // array of base64 data URLs

        // --- attachment menu ---
        function toggleAttachMenu() {
            const menu = document.getElementById('attach-menu');
            const previews = document.getElementById('image-previews');
            // only show menu if no previews visible (to avoid overlap)
            const showing = menu.classList.toggle('visible');
            document.getElementById('attach-icon').textContent = showing ? 'close' : 'add';
        }

        function closeAttachMenu() {
            document.getElementById('attach-menu').classList.remove('visible');
            document.getElementById('attach-icon').textContent = 'add';
        }

        // --- file upload ---
        function triggerFileUpload() {
            closeAttachMenu();
            document.getElementById('file-input').click();
        }

        document.getElementById('file-input').addEventListener('change', function() {
            Array.from(this.files).forEach(file => {
                const reader = new FileReader();
                reader.onload = e => addPreview(e.target.result);
                reader.readAsDataURL(file);
            });
            this.value = '';
        });

        // --- tab / screen capture ---
        async function captureTab() {
            closeAttachMenu();
            try {
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        displaySurface: 'browser', // prefer tab/window picker
                        cursor: 'always'
                    },
                    audio: false,
                    selfBrowserSurface: 'included',  // allow current tab as option
                    surfaceSwitching: 'include',     // let user switch targets
                    systemAudio: 'exclude'
                });
                const video = document.createElement('video');
                video.srcObject = stream;
                await video.play();
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0);
                stream.getTracks().forEach(t => t.stop());
                addPreview(canvas.toDataURL('image/png'));
            } catch (e) {
                if (e.name !== 'AbortError') alert('Could not capture screen: ' + e.message);
            }
        }

        // --- preview management ---
        function addPreview(dataUrl) {
            pendingImages.push(dataUrl);
            renderPreviews();
        }

        function removePreview(idx) {
            pendingImages.splice(idx, 1);
            renderPreviews();
        }

        function renderPreviews() {
            const container = document.getElementById('image-previews');
            container.innerHTML = '';
            pendingImages.forEach((url, i) => {
                const wrap = document.createElement('div');
                wrap.className = 'preview-wrap';
                const img = document.createElement('img');
                img.src = url;
                const rm = document.createElement('div');
                rm.className = 'remove-img';
                rm.textContent = '×';
                rm.onclick = () => removePreview(i);
                wrap.appendChild(img);
                wrap.appendChild(rm);
                container.appendChild(wrap);
            });
        }

        // --- messages ---
        const katexOpts = {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true }
            ],
            throwOnError: false
        };

        function renderBot(el, text) {
            el.innerHTML = DOMPurify.sanitize(marked.parse(text));
            if (window.renderMathInElement) renderMathInElement(el, katexOpts);
        }

        function scrollToBottom(el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }

        function addMessage(content, role, images, trackHistory = true) {
            const message = document.createElement('div');
            message.classList.add('message', role);

            if (typeof content === 'string') {
                if (role === 'bot') {
                    renderBot(message, content);
                } else {
                    message.textContent = content;
                }
            }

            if (images && images.length > 0) {
                images.forEach(url => {
                    const img = document.createElement('img');
                    img.src = url;
                    message.appendChild(img);
                });
            }

            document.querySelector('.messages').appendChild(message);
            scrollToBottom(message);

            if (trackHistory) {
                if (images && images.length > 0) {
                    chatHistory.push({
                        role: 'user',
                        content: [
                            { type: 'text', text: content || '' },
                            ...images.map(u => ({ type: 'image_url', image_url: { url: u } }))
                        ]
                    });
                } else {
                    chatHistory.push({
                        role: role === 'user' ? 'user' : 'assistant',
                        content: content
                    });
                }
            }
        }

        document.querySelector('.search-bar').addEventListener('keydown', e => {
            if (e.key === 'Enter') send();
        });

        // Hook up the send button click event
        document.getElementById('send-btn').addEventListener('click', send);

        async function send() {
            if (genlock) return;
            const input = document.querySelector('.search-bar');
            const message = input.value.trim();
            const images = [...pendingImages];
            if (!message && images.length === 0) return;

            const selectedModel = document.querySelector('.dropdown-option.selected')?.dataset.value;
            const model = selectedModel === '1' ? '1' : '0';

            // Premium gate for GPT-OSS-120B
            if (model === '1') {
                const hasPremium = await axiomPremium.isPremium();
                if (!hasPremium) {
                    addMessage('GPT-OSS-120B requires a premium key. Go to Settings to activate premium.', 'bot', null, false);
                    return;
                }
            }

            genlock = true;
            input.value = '';
            pendingImages = [];
            renderPreviews();
            closeAttachMenu();

            addMessage(message, 'user', images);

            const chatHeaders = { 'Content-Type': 'application/json' };
            const premiumKey = axiomPremium.getKey();
            if (premiumKey) chatHeaders['key'] = premiumKey;

            fetch('/chat', {
                method: 'POST',
                headers: chatHeaders,
                body: JSON.stringify({ message, history: chatHistory.slice(0, -1), images, model })
            }).then(res => res.json()).then(data => {
                if (data.error) {
                    addMessage('Error: ' + data.error, 'bot', null, false);
                } else {
                    addMessage(data.response, 'bot', null);
                }
                genlock = false;
            }).catch(() => {
                addMessage('Error: Failed to connect to AI service', 'bot', null, false);
                genlock = false;
            });
        }

        // help msg (don't track this in history)
        addMessage("Hello! I'm the Axiom AI, press + to attach images or capture a tab to give me visual context!", "bot", null, false);
