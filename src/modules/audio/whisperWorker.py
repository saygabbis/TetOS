"""Worker persistente — carrega faster-whisper uma vez e transcreve via stdin."""
import json
import sys

try:
    from faster_whisper import WhisperModel
except ImportError:
    print(json.dumps({"error": "faster_whisper not installed"}), flush=True)
    sys.exit(1)

model_name = sys.argv[1] if len(sys.argv) > 1 else "small"
language = sys.argv[2] if len(sys.argv) > 2 else "pt"

model = WhisperModel(model_name, device="cpu", compute_type="int8")

for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    try:
        segments, info = model.transcribe(path, language=language, vad_filter=True)
        text = " ".join((segment.text or "").strip() for segment in segments).strip()
        print(
            json.dumps({"text": text, "language": getattr(info, "language", None)}),
            flush=True,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
