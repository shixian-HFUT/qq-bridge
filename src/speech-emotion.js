// Application presets mapped to Qwen-Audio-TTS input.instruction.
// Emotion is separate from spoken text. Neutral keeps the legacy request/cache.
const INSTRUCTIONS = Object.freeze({
  neutral: '',
  happy: '用开心、轻快、带自然笑意的语气说话，保持原有音色，情绪适度。',
  excited: '用兴奋、期待的语气说话，节奏稍轻快，吐字清楚，不喊叫。',
  shy: '用略带羞涩的轻柔语气说话，停顿自然，保持清晰，不刻意拖长尾音。',
  comfort: '用温柔、关切的语气说话，声音柔和，语速稍慢，像在陪伴熟悉的人。',
  sad: '用轻微低落、难过的语气说话，声音稍轻，情绪克制，吐字清楚。',
  serious: '用认真、坚定、清晰的语气说话，保持平稳，避免训斥和喊叫。',
  curious: '用自然好奇、感兴趣的语气说话，语调轻微上扬，不夸张。',
  surprised: '用惊讶、意外的语气说话，反应自然，保持原有音色，不尖叫。',
  playful: '用轻松、俏皮、略带打趣的语气说话，保持友善和自然。',
  tired: '用略显疲倦的语气说话，语速稍慢，声音稍轻，仍然清楚连贯。',
  angry: '用轻微生气但克制、坚定的语气说话，吐字清楚，不吼叫。',
  whisper: '用轻声低语的方式说话，声音柔和，发音清楚，不夸张。',
});

export const SPEECH_EMOTIONS = Object.freeze(Object.keys(INSTRUCTIONS));

export function normalizeSpeechEmotion(value) {
  if (value === undefined) return 'neutral';
  if (typeof value !== 'string' || !Object.hasOwn(INSTRUCTIONS, value)) {
    throw new Error('不支持的语音情绪，请使用可用的 emotion 选项或省略该参数');
  }
  return value;
}

export function speechEmotionInstruction(emotion, model) {
  const selected = normalizeSpeechEmotion(emotion);
  if (selected === 'neutral') return '';
  if (!/^qwen-audio-3\.[01]-tts-(?:flash|plus)$/.test(String(model))) {
    throw new Error('当前语音模型未接入情绪指令控制');
  }
  return INSTRUCTIONS[selected];
}
