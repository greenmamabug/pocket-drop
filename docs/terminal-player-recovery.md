# Terminal recovery for an interrupted update

This launcher uses Pocket Drop 4.7.4's existing recovery engine and signed native runtime. It does not install Node, Python or other system packages. It only handles an already-prepared, interrupted update; it cannot initialize a player or replace its backup.

1. Keep Pocket Drop 4.7.4 in Applications. Quit it with Command–Q and close other player-updater tools.
2. Download and unzip `Pocket-Drop-Terminal-Recovery.zip`. Keep the extracted files together in the `Pocket-Drop-Terminal-Recovery` folder in Downloads.
3. Open Terminal and run:

   ```sh
   /bin/bash "$HOME/Downloads/Pocket-Drop-Terminal-Recovery/Start.command"
   ```

4. Leave the player powered off with the USB cable connected. Press its reset pinhole when the tool says it is waiting.
5. The first session is a read-only connection test. If it fails, the launcher stops before any firmware write. Keep the log path printed in Terminal.
6. If it passes, the saved update is reviewed and hash-checked. A passing read test does not guarantee a successful write. To retry the saved system image, type `WRITE` at the prompt. Press the reset pinhole again when the new session says it is waiting. Keep Terminal open, the Mac awake and the cable connected through the final result.

Success is reported only after the complete image is read back and verified. The existing app recovery journal is updated by the same engine as the GUI, so a failed attempt remains marked incomplete. No write is retried automatically. Original backups and prepared images are retained. A private timestamped log is saved in Pocket Drop's Application Support folder; nothing is uploaded automatically.

Terminal removes the GUI from the operation but still uses mtkclient and macOS's USB serial connection. It is not a confirmed fix for `Device not configured`. Do not use format/erase commands, someone else's firmware backup or a fresh backup from the partially written player.

The launcher has automated flow tests and a native Intel Mac check of its imports against the published app and bundled runtime. Physical Y2/Monterey recovery has not been verified here. Source is included in the download under GPL-3.0-only; Pocket Drop uses Studio Pocket's public firmware engine by Ashworth Digital Ltd. Native-tool sources remain attached to the Pocket Drop 4.7.4 release.
