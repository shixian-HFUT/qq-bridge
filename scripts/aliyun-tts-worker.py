"""Adapt the user's proven SSE synthesizer; never run the old film's main()."""
import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import sys

def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    root = Path(__file__).resolve().parents[1]
    request = json.load(sys.stdin)
    settings = json.loads((root / 'state/tts-settings.json').read_text(encoding='utf-8'))
    secret_path = root / 'state/tts-secrets.json'
    if not os.environ.get('DASHSCOPE_API_KEY') and secret_path.exists():
        local = json.loads(secret_path.read_text(encoding='utf-8'))
        if local.get('apiKey'):
            os.environ['DASHSCOPE_API_KEY'] = local['apiKey']
    text = request['text']
    if not isinstance(text, str) or not text.strip() or len(text) > 120:
        raise ValueError('Speech text must contain 1-120 characters')
    sys.path.insert(0, r'D:\Ai_video\scripts')
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        tts = importlib.import_module('42_redub_ovdal_longsanshu_v014')
        tts.OUT = root / 'state/tts-python'
        tts.CHUNKS = [[text]]
        tts.API_RATE_OVERRIDES = {0: 1.0}
        report = tts.synthesize(0, voice=settings['voiceId'], language_hints=['zh'])
    # 云端流式 WAV 可能保留占位长度；解码后重封装，保留原文件和成功缓存。
    import soundfile as sf
    import hashlib
    source = Path(report['audio'])
    audio, rate = sf.read(str(source), dtype='int16', always_2d=True)
    if rate != 24000 or audio.shape[1] != 1 or not 0 < len(audio) <= rate * 30:
        raise ValueError('Generated audio exceeds limits')
    normalized = root / 'state/tts-python/normalized' / (hashlib.sha256(source.read_bytes()).hexdigest() + '.wav')
    normalized.parent.mkdir(exist_ok=True)
    if not normalized.exists():
        sf.write(str(normalized), audio, rate, subtype='PCM_16')
    print(json.dumps({'ok': True, 'file': str(normalized), 'seconds': report['duration'],
                      'sampleRate': report['sample_rate'], 'cachedReport': str(tts.OUT)}, ensure_ascii=True))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        import traceback
        # External exceptions may contain signed download URLs or response content.
        print(json.dumps({'ok': False, 'error': 'Aliyun TTS failed; inspect restricted local synthesis report',
                          'errorType': type(exc).__name__,
                          'frames': [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                                     for f in traceback.extract_tb(exc.__traceback__)]}))
        sys.exit(1)
