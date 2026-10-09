# Rolepay films

Rolepay's films, built with [Remotion](https://www.remotion.dev). This folder is outside the pnpm workspace on purpose.

- **PitchVideo**: the pitch, on camera or by voice alone, with the animated scenes cut in (`src/timeline/pitch.ts`).
- **DemoVideo**: screen recordings of the product, captioned, with the explainer scenes between them (`src/timeline/demo.ts`).
- **Cuts** of the first mainnet pay run (`src/cuts/`): `ReadmeLoop`, the master for the README GIF, and `XClip`, the same beats with a title and the end card.

Each scene is also its own composition (the studio's Scenes folder).

## Run

```bash
cd video
npm install            # once
npx remotion studio    # preview in the browser
npm run render:pitch   # out/pitch.mp4
npm run render:demo    # out/demo.mp4
npm run render:readme  # out/readme-loop.mp4; then npm run gif:readme (ffmpeg) for out/readme-loop.gif
npm run render:x       # out/x-clip.mp4
npm run stills         # one still of every scene into out/stills/
```

## Recordings

Recordings go in `video/assets/`, under the file names the timelines give each slot. That folder and `video/out/` are gitignored: recordings and renders never go into git. A slot whose file is missing shows a card saying what goes there.
