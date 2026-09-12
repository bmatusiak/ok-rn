package com.okrn.share

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.okrn.specs.NativeShareSpec
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Staging a file and handing it to another app.
 *
 * The staging directory is the one the FileProvider is configured for
 * (res/xml/shared_files.xml). Nothing outside it is reachable through the
 * provider, which matters because what gets staged here is a plaintext backup
 * of everything the key holds.
 */
class NativeShareModule(reactContext: ReactApplicationContext) :
  NativeShareSpec(reactContext) {

  /**
   * The promise waiting on the picker, if one is open.
   *
   * The result does not come back from startActivityForResult — it arrives
   * later on onActivityResult, on a different call stack — so the promise has
   * to be held across the gap. At most one, because a second picker cannot be
   * shown over the first anyway.
   */
  private var pending: Promise? = null

  private val activityListener: ActivityEventListener =
    object : BaseActivityEventListener() {
      override fun onActivityResult(
        activity: Activity,
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
      ) {
        if (requestCode != PICK_FILE_REQUEST) return
        val promise = pending ?: return
        pending = null

        try {
          val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
          if (uri == null) {
            /* Backed out, or chose nothing. A value, not a failure. */
            promise.resolve(picked(false, "", ""))
            return
          }
          promise.resolve(picked(true, displayName(uri), readText(uri)))
        } catch (e: Exception) {
          promise.reject(ERR, e.message ?: "could not read the chosen file", e)
        }
      }
    }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  override fun invalidate() {
    reactApplicationContext.removeActivityEventListener(activityListener)
    /*
     * A promise left unsettled never resolves and never rejects, and the screen
     * awaiting it would sit on "Opening…" for ever.
     */
    pending?.reject(ERR, "the module was torn down while the picker was open")
    pending = null
    super.invalidate()
  }

  private fun stagingDir(): File =
    File(reactApplicationContext.cacheDir, SHARED_DIR).apply { mkdirs() }

  override fun shareFile(
    filename: String,
    content: String,
    mimeType: String,
    title: String,
    promise: Promise,
  ) {
    try {
      val activity = getCurrentActivity()
      if (activity == null) {
        promise.reject(ERR, "no activity; the app is not in the foreground")
        return
      }

      /*
       * The name is taken apart and rebuilt rather than trusted. It reaches
       * this from a screen that builds it from a timestamp, but a filename is
       * the one argument here that becomes a path, and "../" in one would write
       * outside the directory the provider is scoped to.
       */
      val safe = File(filename).name.replace(Regex("[^A-Za-z0-9._-]"), "_")
      if (safe.isEmpty()) {
        promise.reject(ERR, "empty filename")
        return
      }

      val file = File(stagingDir(), safe)
      file.writeText(content)

      val uri = FileProvider.getUriForFile(
        reactApplicationContext,
        "${reactApplicationContext.packageName}.files",
        file,
      )

      val send = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, safe)
        /*
         * The grant travels with the intent. Without it the receiving activity
         * gets a URI it is not allowed to open, which surfaces as a permission
         * denial inside the other app rather than as an error here.
         */
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      val chooser = Intent.createChooser(send, title).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      if (chooser.resolveActivity(reactApplicationContext.packageManager) == null) {
        promise.resolve(false)
        return
      }

      activity.startActivity(chooser)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "share failed", e)
    }
  }

  override fun clearShared(promise: Promise) {
    try {
      val dir = File(reactApplicationContext.cacheDir, SHARED_DIR)
      var removed = 0
      dir.listFiles()?.forEach { file ->
        /*
         * Overwritten before deletion. Deleting a file unlinks it; the bytes
         * stay on the filesystem until something reuses them, and these bytes
         * are the whole contents of a hardware key.
         */
        runCatching {
          val blank = ByteArray(file.length().toInt().coerceAtMost(1 shl 20))
          file.writeBytes(blank)
        }
        if (file.delete()) removed++
      }
      promise.resolve(removed.toDouble())
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "clear failed", e)
    }
  }

  /**
   * What is bundled under one asset directory.
   *
   * `AssetManager.list` answers null for a path that is not a directory and an
   * empty array for one that is empty; both come back as an empty list, because
   * a build with no releases bundled is a configuration rather than a failure
   * and a screen should show "nothing bundled" instead of an error.
   */
  override fun listAssets(dir: String, promise: Promise) {
    try {
      val names = reactApplicationContext.assets.list(dir) ?: emptyArray()
      val out = Arguments.createArray()
      for (name in names.sorted()) out.pushString(name)
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "could not list assets in $dir", e)
    }
  }

  /**
   * One bundled file, as text.
   *
   * Bounded the same way a picked file is, and for the same reason: the content
   * crosses the bridge as a single string. An asset cannot be mis-picked, but
   * the limit costs nothing and keeps the two paths honest with each other.
   */
  override fun readAsset(path: String, promise: Promise) {
    try {
      val text = reactApplicationContext.assets.open(path).use { input ->
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          if (out.size() + n > MAX_BYTES) {
            throw IllegalArgumentException(
              "$path is larger than ${MAX_BYTES / 1024} KB",
            )
          }
          out.write(buf, 0, n)
        }
        String(out.toByteArray(), Charsets.UTF_8)
      }
      promise.resolve(text)
    } catch (e: Exception) {
      promise.reject(ERR, e.message ?: "could not read the bundled file $path", e)
    }
  }

  override fun pickTextFile(mimeType: String, promise: Promise) {
    try {
      val activity = getCurrentActivity()
      if (activity == null) {
        promise.reject(ERR, "no activity; the app is not in the foreground")
        return
      }
      if (pending != null) {
        promise.reject(ERR, "a file picker is already open")
        return
      }

      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        /*
         * ACTION_OPEN_DOCUMENT, not GET_CONTENT: it goes through the system
         * documents UI, which is what reaches Drive and the other providers a
         * backup is likely to have been saved to.
         */
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mimeType
        /*
         * And every type is also offered. A backup is text, but the app that
         * saved it may have typed it application/octet-stream, and a file the
         * user can see but not select is worse than no filter at all.
         */
        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(mimeType, "*/*"))
      }

      pending = promise
      activity.startActivityForResult(intent, PICK_FILE_REQUEST)
    } catch (e: Exception) {
      pending = null
      promise.reject(ERR, e.message ?: "could not open a file picker", e)
    }
  }

  /** What the provider calls the file. Not a path — there need not be one. */
  private fun displayName(uri: Uri): String {
    runCatching {
      reactApplicationContext.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          if (cursor.moveToFirst()) {
            val i = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (i >= 0) return cursor.getString(i) ?: ""
          }
        }
    }
    return uri.lastPathSegment ?: ""
  }

  private fun readText(uri: Uri): String {
    val stream = reactApplicationContext.contentResolver.openInputStream(uri)
      ?: throw IllegalStateException("the chosen file could not be opened")

    /*
     * Bounded as it reads, not after. The content crosses the bridge as one
     * string and is then held in a TextInput, so a wrong pick — a video, a disk
     * image — would be an out-of-memory crash rather than an error message.
     * Checking the length afterwards would mean allocating it first, which is
     * the crash it is meant to prevent.
     */
    return stream.use { input ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(16 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        if (out.size() + n > MAX_BYTES) {
          throw IllegalArgumentException(
            "that file is larger than ${MAX_BYTES / 1024} KB, so it is neither a " +
              "backup nor a signed firmware file",
          )
        }
        out.write(buf, 0, n)
      }
      String(out.toByteArray(), Charsets.UTF_8)
    }
  }

  private fun picked(picked: Boolean, name: String, content: String): WritableMap =
    Arguments.createMap().apply {
      putBoolean("picked", picked)
      putString("name", name)
      putString("content", content)
    }

  companion object {
    const val ERR = "E_SHARE"

    /** Must match the cache-path in res/xml/shared_files.xml. */
    const val SHARED_DIR = "shared"

    /** Distinguishes our result from any other activity the app started. */
    const val PICK_FILE_REQUEST = 0x0C51

    /**
     * 4 MB. A backup is kilobytes and a signed firmware release about 430 KB;
     * this only rules out an obvious mis-pick, such as a video.
     */
    const val MAX_BYTES = 4 * 1024 * 1024
  }
}
