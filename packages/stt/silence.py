"""Transcripts that are not speech: what Whisper writes for noise, silence or a sound too short to hear.

Kept apart from server.py (which loads the model at import) so it can be tested on its own.
"""

import re

# What Whisper writes for a moment of noise or silence (learned from subtitled videos), with full confidence, so
# segment scores cannot catch it. A transcript that is only one of these is no speech.
SILENCE_PHRASES = {
    "altyazı m.k.",
    "altyazı m.k",
    "izlediğiniz için teşekkür ederim.",
    "izlediğiniz için teşekkürler.",
    "abone olmayı unutmayın.",
    "thank you for watching.",
    "thanks for watching!",
    "thank you.",
    "subtitles by the amara.org community",
}
_PHRASES = {p.rstrip(".!?…") for p in SILENCE_PHRASES}

# A short piece repeated over and over with no letter anywhere: "6.0.0.0.0.0.0.0.0", "1 1 1 1 1 1". Spoken
# numbers, codes and versions ("2026", "3.14159", "4.7.1", "100 000") are not like that and pass.
_REPEATED = re.compile(r"(.{1,3}?)\1{5,}")


def no_speech(text: str) -> bool:
    """True for one of SILENCE_PHRASES (Python lowercases "İ" to "i" plus a combining dot, so it is folded first; end
    punctuation ignored), or a letter-free transcript that is mostly one short piece repeated."""
    plain = text.replace("İ", "i").lower().strip().rstrip(".!?…").strip()
    if plain in _PHRASES:
        return True
    if any(ch.isalpha() for ch in plain):
        return False
    run = _REPEATED.search(plain)
    return run is not None and len(run.group(0)) >= 0.6 * len(plain)
