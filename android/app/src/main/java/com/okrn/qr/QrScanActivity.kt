package com.okrn.qr

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A full-screen camera that reads one QR code (NativeQrScanner.scan). CameraX shows the preview and
 * hands frames to ZXing's QR reader; the first code read ends the activity with its text.
 * A release build blocks screenshots and the recents thumbnail: a setup QR is a secret.
 */
class QrScanActivity : ComponentActivity() {

  private val done = AtomicBoolean(false)
  private val analyzer = Executors.newSingleThreadExecutor()
  private lateinit var preview: PreviewView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    /* release builds only, as the app's own screens (useSecureScreen(!__DEV__)): a debug build
     * stays visible to screenshots so its layout can be checked */
    if (!com.okrn.BuildConfig.DEBUG) {
      window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    }

    preview = PreviewView(this)
    val prompt = TextView(this).apply {
      text = intent.getStringExtra(EXTRA_PROMPT) ?: "Point the camera at the QR code"
      setTextColor(Color.WHITE)
      textSize = 16f
      setPadding(48, 48, 48, 24)
      setBackgroundColor(0x99000000.toInt())
    }
    val cancel = Button(this).apply {
      text = "Cancel"
      setOnClickListener { finishWith(null) }
    }
    val bottom = LinearLayout(this).apply {
      gravity = Gravity.CENTER
      setPadding(48, 24, 48, 96)
      addView(cancel)
    }
    setContentView(FrameLayout(this).apply {
      addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      addView(prompt, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP))
      addView(bottom, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    })

    /* the window can be drawn edge to edge (always on Android 15+): the status bar and a camera
     * cutout would cover the prompt, and the 3-button bar or the gesture bar the Cancel button.
     * Each is padded by the bars' real size; the preview alone runs under them */
    ViewCompat.setOnApplyWindowInsetsListener(prompt) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      v.setPadding(48 + bars.left, 48 + bars.top, 48 + bars.right, 24)
      insets
    }
    ViewCompat.setOnApplyWindowInsetsListener(bottom) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      v.setPadding(48 + bars.left, 24, 48 + bars.right, 48 + bars.bottom)
      insets
    }

    /* the camera is asked for here, when Scan was pressed - never at app start */
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      requestPermissions(arrayOf(Manifest.permission.CAMERA), ASK_CAMERA)
    }
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != ASK_CAMERA) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      setResult(RESULT_PERMISSION)
      finish()
    }
  }

  private fun startCamera() {
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener({
      val provider = future.get()
      val shown = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
      val frames = ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
      frames.setAnalyzer(analyzer) { image -> read(image) }
      provider.unbindAll()
      provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, shown, frames)
    }, ContextCompat.getMainExecutor(this))
  }

  /* one frame: the Y plane is the luminance ZXing reads; no code in it -> the next frame */
  private fun read(image: ImageProxy) {
    try {
      if (done.get()) return
      val plane = image.planes[0]
      val buffer = plane.buffer
      val bytes = ByteArray(buffer.remaining())
      buffer.get(bytes)
      val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
      val hints = mapOf(DecodeHintType.TRY_HARDER to true, DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE))
      val text = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
      if (text != null) runOnUiThread { finishWith(text) }
    } catch (_: Exception) {
      /* not found / not readable in this frame */
    } finally {
      image.close()
    }
  }

  private fun finishWith(text: String?) {
    if (!done.compareAndSet(false, true)) return
    if (text == null) setResult(Activity.RESULT_CANCELED) else setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_TEXT, text))
    finish()
  }

  override fun onDestroy() {
    analyzer.shutdown()
    super.onDestroy()
  }

  companion object {
    const val EXTRA_PROMPT = "com.okrn.qr.PROMPT"
    const val EXTRA_TEXT = "com.okrn.qr.TEXT"
    const val RESULT_PERMISSION = Activity.RESULT_FIRST_USER + 1
    private const val ASK_CAMERA = 61
  }
}
