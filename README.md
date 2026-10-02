# Camera Recorder

A local-first Electron app for live camera preview and segmented video recording.

## Features

- Live preview from the built-in or attached camera.
- Video-only recording saved as independent WebM clips.
- Configurable clip duration, resolution, frame rate, and target bitrate.
- Approximate clip size shown from the selected target bitrate.
- Choose any local destination folder, including a Dropbox-synced folder.
- Option to keep the display awake while recording; otherwise the app prevents system idle sleep while allowing the display to sleep.
- Camera permission is requested through macOS and recordings stay local unless the destination folder is synced by another service.

## Development

```sh
npm install
npm run dev
```

## macOS package

```sh
npm run package:mac
```

The app requests camera permission only when the user starts the camera. It does not request microphone access or record audio.
