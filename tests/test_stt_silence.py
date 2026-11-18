"""What the speech-to-text service treats as no speech (packages/stt/silence.py)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "stt"))
from silence import no_speech  # noqa: E402


class NoSpeechTests(unittest.TestCase):
    def test_stock_phrases_with_a_capital_turkish_i(self):
        # Python lowercases "İ" to "i" + a combining dot; the phrase must still match.
        self.assertTrue(no_speech("İzlediğiniz için teşekkür ederim."))
        self.assertTrue(no_speech("Thanks for watching!"))

    def test_a_repeated_number_run_is_not_speech(self):
        self.assertTrue(no_speech("6.0.0.0.0.0.0.0.0.0.0.0.0"))

    def test_spoken_numbers_codes_and_versions_stay(self):
        for said in ("2026", "3.14159", "4.7.1", "100 000", "1, 2, 3", "0532 123 45 67"):
            self.assertFalse(no_speech(said), said)

    def test_words_stay(self):
        self.assertFalse(no_speech("Okay, I'm testing it."))
        self.assertFalse(no_speech("Evet"))


if __name__ == "__main__":
    unittest.main()
