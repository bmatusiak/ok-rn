package com.okrn.qr

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.WriterException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.okrn.specs.NativeQrScannerSpec

/**
 * specs/NativeQrScanner.ts: starts QrScanActivity for a result and resolves with the QR code's
 * text, null when the person backs out, or rejects PERMISSION when the camera was refused.
 * One scan at a time.
 */
class NativeQrScannerModule(private val reactContext: ReactApplicationContext) : NativeQrScannerSpec(reactContext) {

  private var pending: Promise? = null

  private val listener: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != REQUEST) return
      val p = pending ?: return
      pending = null
      when (resultCode) {
        Activity.RESULT_OK -> p.resolve(data?.getStringExtra(QrScanActivity.EXTRA_TEXT))
        QrScanActivity.RESULT_PERMISSION -> p.reject("PERMISSION", "the camera permission was refused")
        else -> p.resolve(null)
      }
    }
  }

  init {
    reactContext.addActivityEventListener(listener)
  }

  override fun scan(prompt: String, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "no screen to open the camera from")
      return
    }
    if (pending != null) {
      promise.reject("BUSY", "a scan is already open")
      return
    }
    pending = promise
    activity.startActivityForResult(Intent(activity, QrScanActivity::class.java).putExtra(QrScanActivity.EXTRA_PROMPT, prompt), REQUEST)
  }

  /*
   * DRAW a QR code (Guest Book's My card; spec: "The OnlyKey logo in every QR the app makes", Brad
   * 2026-10-11). ZXing's writer at error correction H (about 30% of the code may be lost), then the
   * OnlyKey mark on a white pad in the middle - about 9% of the area, well under what H tolerates.
   * The code is then READ BACK here with ZXing's reader: if the logo made it unreadable, the plain
   * code is returned instead - a code too dense for the logo drops the logo, never the scan.
   * Resolves a PNG data URI; rejects TOO_BIG when the text does not fit one QR code.
   */
  override fun render(text: String, size: Double, promise: Promise) {
    Thread {
      try {
        val px = size.toInt().coerceIn(128, 2048)
        val hints = mapOf(
          EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.H,
          EncodeHintType.MARGIN to 2,
          EncodeHintType.CHARACTER_SET to "UTF-8",
        )
        val matrix = try {
          QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, px, px, hints)
        } catch (e: WriterException) {
          promise.reject("TOO_BIG", "too much for one QR code (${text.length} characters)")
          return@Thread
        }
        val plain = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        for (y in 0 until px) for (x in 0 until px) plain.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
        val withLogo = plain.copy(Bitmap.Config.ARGB_8888, true)
        drawLogo(withLogo)
        val out = if (readsBack(withLogo, text)) withLogo else plain
        val bytes = java.io.ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.PNG, 100, bytes)
        promise.resolve("data:image/png;base64," + android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP))
      } catch (e: Exception) {
        promise.reject("RENDER", e.message ?: "the QR code could not be drawn", e)
      }
    }.start()
  }

  /* the OnlyKey mark (res/drawable-nodpi/ic_o_mark.png) on a white pad, 30% of the side */
  private fun drawLogo(bmp: Bitmap) {
    val mark = BitmapFactory.decodeResource(reactContext.resources, com.okrn.R.drawable.ic_o_mark) ?: return
    val side = bmp.width * 0.30f
    val pad = side * 0.12f
    val left = (bmp.width - side) / 2f
    val top = (bmp.height - side) / 2f
    val canvas = Canvas(bmp)
    canvas.drawRect(RectF(left, top, left + side, top + side), Paint().apply { color = Color.WHITE })
    val scale = minOf((side - 2 * pad) / mark.width, (side - 2 * pad) / mark.height)
    val w = mark.width * scale
    val h = mark.height * scale
    val dst = RectF((bmp.width - w) / 2f, (bmp.height - h) / 2f, (bmp.width + w) / 2f, (bmp.height + h) / 2f)
    canvas.drawBitmap(mark, null, dst, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
  }

  private fun readsBack(bmp: Bitmap, text: String): Boolean = try {
    val pixels = IntArray(bmp.width * bmp.height)
    bmp.getPixels(pixels, 0, bmp.width, 0, 0, bmp.width, bmp.height)
    val source = RGBLuminanceSource(bmp.width, bmp.height, pixels)
    val read = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), mapOf(DecodeHintType.TRY_HARDER to true))
    read.text == text
  } catch (_: Exception) {
    false
  }

  companion object {
    private const val REQUEST = 6107
  }
}
