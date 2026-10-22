import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Reuse the app's vector mark; the generous inset keeps it inside Android's
// maskable icon safe area, regardless of the launcher's chosen shape.
const source = readFileSync(
  new URL("../src/app/icon.svg", import.meta.url),
  "utf8",
);
const output = new URL("../public/icons/", import.meta.url);
mkdirSync(output, { recursive: true });
for (const [name, size, inset] of [
  ["pwa-192", 192, 36],
  ["pwa-512", 512, 96],
  ["maskable-512", 512, 110],
]) {
  const mark = await sharp(Buffer.from(source))
    .resize(size - inset * 2, size - inset * 2, {
      fit: "contain",
      background: "transparent",
    })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: "#050816" },
  })
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toFile(fileURLToPath(new URL(`${name}.png`, output)));
}
await sharp(Buffer.from(source.replaceAll("#208BEB", "#ffffff")))
  .resize(96, 96, { fit: "contain", background: "transparent" })
  .png()
  .toFile(fileURLToPath(new URL("badge-96.png", output)));
