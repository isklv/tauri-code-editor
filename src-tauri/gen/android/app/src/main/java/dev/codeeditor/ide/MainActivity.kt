package dev.codeeditor.ide

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestAllFilesAccessOnce()
  }

  /**
   * A code editor needs to open project folders anywhere on shared storage,
   * which on Android 11+ means the "All files access" special permission.
   *
   * It cannot be granted from a normal permission dialog, only from Settings,
   * so send the user there once. If they decline, the app still works — the
   * explorer falls back to the app's own storage directory.
   */
  private fun requestAllFilesAccessOnce() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    if (Environment.isExternalStorageManager()) return

    val prefs = getSharedPreferences("code-editor", MODE_PRIVATE)
    if (prefs.getBoolean(ASKED_KEY, false)) return
    prefs.edit().putBoolean(ASKED_KEY, true).apply()

    val scoped = Intent(
      Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
      Uri.parse("package:$packageName"),
    )
    val fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
    for (intent in listOf(scoped, fallback)) {
      if (intent.resolveActivity(packageManager) != null) {
        startActivity(intent)
        return
      }
    }
  }

  private companion object {
    const val ASKED_KEY = "asked_all_files_access"
  }
}
