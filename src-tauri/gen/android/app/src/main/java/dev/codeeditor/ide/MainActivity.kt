package dev.codeeditor.ide

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      requestAllFilesAccessOnce()
    } else {
      requestStoragePermissions()
    }

    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
      val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      if (imeVisible && imeInsets.bottom > 0) {
        view.setPadding(0, 0, 0, imeInsets.bottom)
      } else {
        view.setPadding(0, 0, 0, 0)
      }
      insets
    }
  }

  private fun requestStoragePermissions() {
    val permissions = mutableListOf<String>()
    if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }
    if (permissions.isNotEmpty()) {
      requestPermissions(permissions.toTypedArray(), 1001)
    }
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
    const val ASKED_KEY = "asked_all_files_access_v3"
  }
}
