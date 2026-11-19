// What the speech server is given to read aloud: the 🎤 of a voice message made it say "Tom" or "Pin".
import { expect, test } from "bun:test";
import { plain } from "../packages/server/src/speech";

test("emoji, markdown signs, code and links are not read aloud", () => {
  expect(plain("🎤 Please check the release notes before we tag version 2.")).toBe("Please check the release notes before we tag version 2.");
  expect(plain("👍🏽 **done** ✅ see https://example.com/x")).toBe("done see (link)");
  expect(plain("@maya the fix: ```ls -la``` ❤️")).toBe("maya the fix: (code)");
});
