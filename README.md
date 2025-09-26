# Miro-lite (no auth) — GitHub Pages + Firebase Realtime Database

Single shared board. Anyone with the URL can draw, type, and drop images. No authentication. Uses Firebase Realtime Database with fully open rules.

## Setup
1. Create a Firebase project and a **Realtime Database** (RTDB). Copy your web app config (apiKey, authDomain, databaseURL, etc.).
2. In RTDB Rules, set:
   ```json
   {
     "rules": { ".read": true, ".write": true }
   }
   ```
   This is public read/write. Use only for demos.
3. Open `index.html` and replace the **firebaseConfig** placeholders.
4. Push this folder to a GitHub repo and enable GitHub Pages.
5. Open the Pages URL. Everyone on the URL edits the same board.

## Notes
- Images are stored as base64 strings in RTDB. They are capped and compressed to WebP (fallback PNG). Keep images small.
- Tools: Draw lines, add text, drop images, switch to Move for repositioning, and use Erase to delete individual strokes.
- Move tool: drag to reposition, or grab the bottom-right corner to scale text and images.
- Keyboard: Ctrl+Z to undo, Ctrl+Shift+Z / Ctrl+Y to redo.
- Navigation: Use the mouse wheel to zoom and right-click drag to pan within a large (20k×20k) board.
- Admin clear: Click the Erase tool five times quickly and enter password `chatchoo123` to wipe the shared board for everyone.
