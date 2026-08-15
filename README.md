# Code Editor for Android

VS Code-подобный редактор кода для Android на базе **Tauri v2 + Monaco Editor + xterm.js**.

## Архитектура

```
┌──────────────────────────────────────┐
│           Android (APK)              │
│  ┌────────────────────────────────┐  │
│  │        WebView (UI)            │  │
│  │  Monaco Editor  +  xterm.js    │  │
│  └───────────┬────────────────────┘  │
│              │ IPC (JSON)            │
│  ┌───────────▼────────────────────┐  │
│  │    Rust Backend (JNI/NDK)      │  │
│  │  - PTY Terminal                 │  │
│  │  - File System                  │  │
│  │  - Git (git2)                   │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

## Требования

- **Node.js** 20+
- **Rust** 1.80+ (через rustup)
- **pnpm** (или npm)

## Установка

```bash
# 1. Установить Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# 2. Установить pnpm
npm install -g pnpm

# 3. Собрать фронтенд
pnpm install

# 4. Запустить на десктопе (для тестирования)
pnpm tauri dev

# 5. Собрать APK для Android
#    (нужен Android SDK + NDK)
pnpm tauri android build
```

## Для Android-билда

```bash
# Установить Android SDK
tauri android init

# Добавить поддержку Android
tauri android init --package dev.codeeditor.app

# Запустить на эмуляторе/устройстве
tauri android dev

# Собрать APK
tauri android build
```

## Функции MVP

- [x] Monaco Editor (VS Code движок)
- [x] Файловый менеджер
- [x] Терминал (xterm.js)
- [x] Тёмная тема
- [x] Сохранение файлов (Ctrl+S)
- [ ] LSP (автодополнение)
- [ ] Git-интеграция
- [ ] Терминал с PTY

## Следующие шаги

1. **PTY-терминал** — подключить настоящий терминал через Rust backend
2. **LSP** — добавить gopls, pyright, rust-analyzer
3. **Git** — git2 crate для Git-операций
4. **Тач-навигация** — адаптация UI под тачскрин
5. **Жесты** — swipe для переключения файлов
