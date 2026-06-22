# AGENTS.md — Notees Mobile (Flutter)

This file contains project-specific context for the first-class Flutter mobile app in `mobile_flutter/`.

## Overview

The Flutter app is a **hybrid native shell** for Notees. It provides native Android and iOS experiences for the workflows users do most often on phones, while embedding the existing React web app in a WebView for the full editor, whiteboard, QueryAST views, and complex features.

- **Package**: `com.notees.notees` (Android)
- **Display name**: `Notees`
- **Functional accent**: sage green `#5B7D5B`
- **Architecture**: feature-first Flutter with Provider + ChangeNotifier, Dio, go_router, sqflite
- **Native features**: biometric app lock, offline quick-capture queue, share receiver, push-notification prep, keyboard-snapped edit toolbar, bottom navigation, advanced search filters, reusable node picker

## Key Files

```
mobile_flutter/
├── lib/
│   ├── main.dart
│   ├── app.dart
│   ├── core/
│   │   ├── api/              # Dio client + auth interceptor
│   │   ├── routing/          # go_router deep-link config
│   │   ├── secure/           # flutter_secure_storage wrapper
│   │   └── theme/            # RosellRamos theme + accent picker
│   ├── data/
│   │   ├── models/           # ServerProfile, User, Node
│   │   └── repositories/     # Auth, Server, Workspace, Node
│   ├── presentation/
│   │   ├── providers/        # AuthProvider
│   │   ├── screens/          # Splash, ServerSetup, Login, Dashboard, etc.
│   │   └── widgets/          # Fleet-styled cards, section titles
│   └── native/               # WebView editor + JS bridge (WIP)
├── android/                  # Android platform project
├── ios/                      # iOS platform project
├── build-apk.sh             # Docker-based debug APK build
├── Dockerfile               # Flutter build image
└── AGENTS.md                # This file
```

## Build

Local builds require Flutter SDK. For a containerized build with no host dependencies:

```bash
cd mobile_flutter
./build-apk.sh
```

This outputs `dist/notees.apk`.

## Design System

- Monochrome base layer dominates 90%+ of the UI.
- Functional accent (sage `#5B7D5B`) is used only for selected states, badges, primary buttons, and status indicators.
- Cards use `borderRadius: 20`, zero elevation, subtle outline at 10% opacity.
- Bottom sheets use top radius of 28.
- Dynamic color is supported via `dynamic_color` and can be enabled in Settings.

## Push Notifications

FCM plumbing is wired but requires operator configuration for each self-hosted instance:

1. Create a Firebase project and add Android app `com.notees.notees`.
2. Replace `android/app/google-services.json` with the downloaded config.
3. Set `FCM_SERVER_KEY` on the Notees server (or swap the adapter for FCM HTTP v1).
4. The app registers its token at `POST /api/auth/device-token` after login.

`android/app/google-services.json` is tracked as a placeholder so CI builds succeed; it will not deliver notifications until replaced.

## WebView Bridge Contract

The embedded editor loads the user's self-hosted Notees server. A lightweight JS bridge coordinates native ↔ web:

- **Native → Web**: `window.noteesMobileEditor.applyFormat(...)`, `insertLink()`, `insertDate()`
- **Web → Native**: `window.FlutterBridge.openServerSettings()`, `shareText(text)`, `openUrl(url)`, `editorFocusChanged(focused)`

## Security Notes

- Server credentials and tokens are stored in `flutter_secure_storage`.
- The app only loads the user-configured server origin in the WebView.
- External links from the WebView are rejected and left to the system browser.
- Biometric lock is enabled in Settings and gates app resume.

## Skill References

- `rosellramos-app-creator` — scaffold and fleet design system
- `flutter-ui-patterns` — cards, lists, empty states, bottom sheets
- `flutter-play-store-release` — signing, AAB, Play Console
- `security-hardening` — token storage, HTTPS, input validation
- `accessibility-primer` — touch targets, focus, labels
