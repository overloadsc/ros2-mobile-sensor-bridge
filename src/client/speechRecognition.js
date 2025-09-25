class SpeechRecognitionManager {
    constructor() {
        this.speechRecognitionStarted = false;
        this.recognizer = null;
        this.keyword = "苹果"; // Default value that will be updated from config
        this.finalTranscripts = "";
        this.transcriptionTimer = null;
        this.logDiv = document.getElementById('transcription-log');
        this.restartAttempts = 0;
        this.maxRestartAttempts = 5;
        this.restartDelay = 1000; // 初始重启延迟
        this.isRestarting = false;
        console.log('Speech Recognition Manager initialized');
        
        // Load the keyword from config file
        this.loadConfigFromServer();
    }

    async loadConfigFromServer() {
        try {
            const response = await fetch('/api/config');
            if (response.ok) {
                const config = await response.json();
                if (config.microphone && config.microphone.wake_word) {
                    this.keyword = config.microphone.wake_word;
                    console.log(`Wake word loaded from config: "${this.keyword}"`);
                }
            } else {
                console.error('Failed to load config:', response.statusText);
            }
        } catch (error) {
            console.error('Error loading config:', error);
        }
    }

    logTranscription(prompt) {
        // Log to console
        console.log(`Transcribed: "${prompt}"`);
        console.log(`Timestamp: ${new Date().toISOString()}`);
        
        // Log to UI
        if (this.logDiv) {
            const timestamp = new Date().toLocaleTimeString();
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            logEntry.innerHTML = `<span class="timestamp">${timestamp}</span>${prompt}`;
            
            this.logDiv.insertBefore(logEntry, this.logDiv.firstChild);
            
            // Keep only last 10 entries
            while (this.logDiv.children.length > 10) {
                this.logDiv.removeChild(this.logDiv.lastChild);
            }
        }
    }

    // Helper to detect iOS devices
    isIOSDevice() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    // Main iOS audio context activation - now using the shared context
    async ensureAudioContextForIOS() {
        if (!this.isIOSDevice()) return true;
        
        console.log('Ensuring audio context is active for iOS speech recognition');
        
        // Use the shared audio context from main.js
        if (window.sharedAudioContext) {
            const audioContext = window.sharedAudioContext;
            
            // Make sure the context is running
            if (audioContext.state === 'suspended') {
                try {
                    await audioContext.resume();
                    console.log('Shared audio context resumed for speech recognition');
                    return true;
                } catch (err) {
                    console.error('Failed to resume shared audio context:', err);
                    return false;
                }
            } else {
                console.log('Shared audio context already running');
                return true;
            }
        } else {
            console.warn('No shared audio context available for iOS');
            return false;
        }
    }

    async startSpeechRecognition(ws, isSessionActive) {
        if (this.speechRecognitionStarted || !isSessionActive || this.isRestarting) {
            return;
        }
        
        // 检查浏览器支持
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            throw new Error('Speech Recognition API not supported');
        }

        try {
            // For iOS devices, make sure audio is active before starting speech recognition
            if (this.isIOSDevice()) {
                await this.ensureAudioContextForIOS();
            }
            
            this.recognizer = new SpeechRecognition();
            
            // 优化语音识别设置
            this.recognizer.continuous = true;
            this.recognizer.interimResults = true; // 启用中间结果以提高响应性
            this.recognizer.lang = "zh-CN";
            this.recognizer.maxAlternatives = 3; // 获取多个识别结果
            
            // 设置语音识别的敏感度参数（如果支持）
            if ('webkitSpeechRecognition' in window) {
                this.recognizer.serviceURI = 'wss://www.google.com/speech-api/v2/recognize';
            }

            this.recognizer.onstart = () => {
                console.log('Speech recognition started');
                this.restartAttempts = 0; // 重置重启计数
                this.logTranscription('语音识别已启动');
            };

            this.recognizer.onresult = (event) => {
                let interimTranscript = '';
                let finalTranscript = '';
                
                for(let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript.trim();
                    
                    if(event.results[i].isFinal) {
                        finalTranscript += transcript;
                    } else {
                        interimTranscript += transcript;
                    }
                }
                
                // 检查最终结果是否包含关键词
                if (finalTranscript && finalTranscript.includes(this.keyword)) {
                    console.log('Final transcript with keyword:', finalTranscript);
                    this.sendTranscription(ws, finalTranscript);
                }
                
                // 也可以检查中间结果，提高响应性
                if (interimTranscript && interimTranscript.includes(this.keyword)) {
                    console.log('Interim transcript with keyword:', interimTranscript);
                    // 可以选择是否发送中间结果
                    // this.sendTranscription(ws, interimTranscript);
                }
            };

            this.recognizer.onerror = (event) => {
                console.error('Recognition error:', event.error);
                this.logTranscription(`识别错误: ${event.error}`);
                
                // 处理不同类型的错误
                switch(event.error) {
                    case 'network':
                        this.logTranscription('网络错误，将尝试重新连接');
                        break;
                    case 'not-allowed':
                        this.logTranscription('麦克风权限被拒绝');
                        return; // 不要重启
                    case 'no-speech':
                        this.logTranscription('未检测到语音');
                        break;
                    case 'audio-capture':
                        this.logTranscription('音频捕获失败');
                        break;
                    case 'aborted':
                        this.logTranscription('识别被中止');
                        return; // 不要重启
                    default:
                        this.logTranscription(`未知错误: ${event.error}`);
                }
                
                // 错误后尝试重启
                this.attemptRestart();
            };

            this.recognizer.onend = () => {
                console.log('Speech recognition ended');
                
                // 只有在应该继续运行时才重启
                if (this.speechRecognitionStarted && !this.isRestarting) {
                    this.attemptRestart();
                }
            };

            this.recognizer.start();
            this.speechRecognitionStarted = true;
            console.log('Speech recognition started with Chinese language support');
            
            // Keep the audio context active for iOS
            if (this.isIOSDevice() && window.sharedAudioContext) {
                this.keepAliveInterval = setInterval(() => {
                    if (window.sharedAudioContext.state === 'suspended') {
                        window.sharedAudioContext.resume().then(() => {
                            console.log('Shared context resumed by speech recognition');
                        }).catch(e => {
                            console.error('Failed to resume audio context:', e);
                        });
                    }
                }, 5000);
            }
            
        } catch (err) {
            console.error('Speech recognition error:', err);
            this.logTranscription(`启动失败: ${err.message}`);
            alert('语音识别启动失败: ' + err.message);
        }
    }

    sendTranscription(ws, transcript) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            const now = Date.now();
            ws.send(JSON.stringify({ 
                header: {
                    stamp: {
                        sec: Math.floor(now / 1000),
                        nanosec: (now % 1000) * 1000000
                    },
                    frame_id: 'microphone_frame'
                },
                transcription: transcript
            }));
            console.log('Sent transcript:', transcript);
            this.logTranscription(`发送: ${transcript}`);
        }
    }

    attemptRestart() {
        if (this.isRestarting || !this.speechRecognitionStarted) {
            return;
        }
        
        if (this.restartAttempts >= this.maxRestartAttempts) {
            console.error('Maximum restart attempts reached, stopping speech recognition');
            this.logTranscription('达到最大重启次数，停止语音识别');
            this.speechRecognitionStarted = false;
            return;
        }
        
        this.isRestarting = true;
        this.restartAttempts++;
        
        // 指数退避策略
        const delay = this.restartDelay * Math.pow(2, this.restartAttempts - 1);
        
        console.log(`Attempting to restart speech recognition (attempt ${this.restartAttempts}/${this.maxRestartAttempts}) in ${delay}ms`);
        this.logTranscription(`尝试重启语音识别 (${this.restartAttempts}/${this.maxRestartAttempts})`);
        
        setTimeout(() => {
            if (this.speechRecognitionStarted) {
                try {
                    this.isRestarting = false;
                    if (this.recognizer) {
                        this.recognizer.start();
                    }
                } catch (err) {
                    console.error('Failed to restart speech recognition:', err);
                    this.isRestarting = false;
                    // 继续尝试重启
                    this.attemptRestart();
                }
            } else {
                this.isRestarting = false;
            }
        }, delay);
    }

    stopSpeechRecognition() {
        console.log('Stopping speech recognition');
        this.speechRecognitionStarted = false;
        this.isRestarting = false;
        this.restartAttempts = 0;
        
        if (this.recognizer) {
            try {
                this.recognizer.stop();
            } catch (err) {
                console.error('Error stopping recognizer:', err);
            }
            this.recognizer = null;
        }
        
        if (this.transcriptionTimer) {
            clearTimeout(this.transcriptionTimer);
            this.transcriptionTimer = null;
        }
        
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        
        this.finalTranscripts = "";
        
        // Clear log when stopping
        if (this.logDiv) {
            this.logDiv.innerHTML = '';
        }
        
        console.log('Speech recognition stopped');
        this.logTranscription('语音识别已停止');
    }
}

window.SpeechRecognitionManager = SpeechRecognitionManager;