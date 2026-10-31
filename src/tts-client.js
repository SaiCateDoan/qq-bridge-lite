// GPT-SoVITS 本地 API 客户端：只允许回环地址，避免把 TTS 变成任意外发通道。
//
// 上游事实（api_v2.py）：
//   POST /tts  { text, text_lang, ref_audio_path, prompt_text, prompt_lang,
//                media_type, streaming_mode, speed_factor, ... }
//   成功直接返回音频字节流；失败返回 400 JSON。
// 参考音频的路径是 **API 所在机器** 的路径，不是 qq-bridge 进程的 cwd 相对路径。

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class GptSovitsClient {
  constructor({
    baseUrl = 'http://127.0.0.1:9880',
    refAudioPath = '',
    promptText = '',
    promptLang = 'zh',
    textLang = 'zh',
    speedFactor = 1,
    maxBytes = 20 * 1024 * 1024,
    timeoutMs = 120000,
    mediaType = 'wav',
    textSplitMethod = 'cut5',
    repetitionPenalty = 1.35
  } = {}) {
    let parsed;
    try { parsed = new URL(String(baseUrl)); } catch { throw new Error('TTS apiUrl 不是合法 URL'); }
    if (!/^https?:$/.test(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new Error('TTS apiUrl 必须是本机回环地址（127.0.0.1 / localhost / ::1）');
    }
    if (!refAudioPath) throw new Error('TTS 缺少参考音频路径（socialV2.tts.refAudioPath）');
    if (!promptText) throw new Error('TTS 缺少参考音频原话（socialV2.tts.promptText）');
    this.baseUrl = parsed.href.replace(/\/+$/, '');
    this.refAudioPath = refAudioPath;
    this.promptText = promptText;
    this.promptLang = promptLang;
    this.textLang = textLang;
    this.speedFactor = speedFactor;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.mediaType = mediaType;
    this.textSplitMethod = textSplitMethod;
    this.repetitionPenalty = repetitionPenalty;
  }

  async synthesize(text, { textLang = null, speedFactor = null, timeoutMs = null } = {}) {
    const value = String(text ?? '').trim();
    if (!value) throw new Error('TTS 文本不能为空');
    const body = {
      text: value,
      text_lang: textLang || this.textLang,
      ref_audio_path: this.refAudioPath,
      prompt_text: this.promptText,
      prompt_lang: this.promptLang,
      media_type: this.mediaType,
      text_split_method: this.textSplitMethod,
      streaming_mode: false,
      speed_factor: Number(speedFactor ?? this.speedFactor) || 1,
      repetition_penalty: this.repetitionPenalty
    };
    let res;
    try {
      res = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || this.timeoutMs))
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error(`TTS 超时（${Math.round((Number(timeoutMs) || this.timeoutMs) / 1000)}s）`);
      throw new Error(`TTS 请求失败：${error?.message ?? error}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.parse(buf.toString('utf8'))?.Exception || ''; } catch {}
      throw new Error(`TTS 合成失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
    }
    if (buf.length === 0) throw new Error('TTS 返回空音频');
    if (buf.length > this.maxBytes) throw new Error(`TTS 音频过大（${buf.length} > ${this.maxBytes}）`);
    const mime = String(res.headers.get('content-type') || '').toLowerCase();
    if (mime && !mime.includes('audio') && !mime.includes('octet-stream')) {
      throw new Error(`TTS 返回的不是音频（${mime}）`);
    }
    // WAV 头校验：防止把 JSON 错误页当音频发给 QQ。
    if (this.mediaType === 'wav' && !(buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE')) {
      throw new Error('TTS 返回的 WAV 头无效');
    }
    return { buffer: buf, mimeType: mime || 'audio/wav', bytes: buf.length };
  }
}
