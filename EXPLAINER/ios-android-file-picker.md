Here is the complete implementation with all the source code files and code examples you need to drop directly into your app.

---

### 1. iOS Implementation

**`ios/FilePickerModule.swift`**

```swift
import Foundation
import UIKit
import UniformTypeIdentifiers

@objc(FilePickerModule)
class FilePickerModule: NSObject, UIDocumentPickerDelegate {
  private var resolveBlock: RCTPromiseResolveBlock?
  private var rejectBlock: RCTPromiseRejectBlock?

  @objc static func requiresMainQueueSetup() -> Bool {
    return true
  }

  @objc func pickFile(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    self.resolveBlock = resolve
    self.rejectBlock = reject

    DispatchQueue.main.async {
      // asCopy: true ensures cloud files (Drive, iCloud) download to local app temp storage
      let documentPicker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
      documentPicker.delegate = self
      documentPicker.allowsMultipleSelection = false

      if let rootVC = UIApplication.shared.keyWindow?.rootViewController {
        rootVC.present(documentPicker, animated: true, completion: nil)
      } else {
        reject("NO_VC", "Could not find root view controller", nil)
      }
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first else {
      rejectBlock?("NO_FILE", "No file selected", nil)
      return
    }
    
    let dict: [String: Any] = [
      "uri": url.absoluteString,
      "name": url.lastPathComponent
    ]
    resolveBlock?(dict)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    rejectBlock?("CANCELLED", "User cancelled picker", nil)
  }
}

```

**`ios/FilePickerModule.m`**

```objc
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(FilePickerModule, NSObject)
RCT_EXTERN_METHOD(pickFile:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end

```

---

### 2. Android Implementation

Replace `com.myapp` at the top of these files with your app's package name.

**`android/app/src/main/java/com/myapp/FilePickerModule.java`**

```java
package com.myapp; // Replace with your package name

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.database.Cursor;
import android.provider.OpenableColumns;

import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

public class FilePickerModule extends ReactContextBaseJavaModule {
    private static final int PICK_FILE_REQUEST = 999;
    private Promise mPromise;

    private final ActivityEventListener mActivityEventListener = new BaseActivityEventListener() {
        @Override
        public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent intent) {
            if (requestCode == PICK_FILE_REQUEST) {
                if (mPromise != null) {
                    if (resultCode == Activity.RESULT_OK && intent != null && intent.getData() != null) {
                        Uri uri = intent.getData();
                        String fileName = getFileName(uri);

                        WritableMap map = Arguments.createMap();
                        map.putString("uri", uri.toString());
                        map.putString("name", fileName);
                        mPromise.resolve(map);
                    } else {
                        mPromise.reject("CANCELLED", "User cancelled picker");
                    }
                    mPromise = null;
                }
            }
        }
    };

    public FilePickerModule(ReactApplicationContext reactContext) {
        super(reactContext);
        reactContext.addActivityEventListener(mActivityEventListener);
    }

    @Override
    public String getName() {
        return "FilePickerModule";
    }

    @ReactMethod
    public void pickFile(Promise promise) {
        Activity currentActivity = getCurrentActivity();
        if (currentActivity == null) {
            promise.reject("NO_ACTIVITY", "Activity doesn't exist");
            return;
        }

        mPromise = promise;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*"); // Opens Drive, local storage, downloads

        currentActivity.startActivityForResult(intent, PICK_FILE_REQUEST);
    }

    private String getFileName(Uri uri) {
        String result = null;
        if (uri.getScheme().equals("content")) {
            try (Cursor cursor = getReactApplicationContext().getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index != -1) result = cursor.getString(index);
                }
            }
        }
        if (result == null) {
            result = uri.getPath();
            int cut = result.lastIndexOf('/');
            if (cut != -1) result = result.substring(cut + 1);
        }
        return result;
    }
}

```

**`android/app/src/main/java/com/myapp/FilePickerPackage.java`**

```java
package com.myapp; // Replace with your package name

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class FilePickerPackage implements ReactPackage {
    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }

    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        List<NativeModule> modules = new ArrayList<>();
        modules.add(new FilePickerModule(reactContext));
        return modules;
    }
}

```

**Register Package in `MainApplication.kt` (or `.java`):**

```kotlin
override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        // Add this line to register your custom package:
        add(FilePickerPackage())
    }

```

---

### 3. JavaScript Component Example

**`src/FilePickerButton.js`**

```javascript
import React, { useState } from 'react';
import { View, Button, Text, NativeModules, Alert, StyleSheet } from 'react-native';

const { FilePickerModule } = NativeModules;

export default function FilePickerButton() {
  const [file, setFile] = useState(null);

  const handlePickFile = async () => {
    try {
      const selectedFile = await FilePickerModule.pickFile();
      setFile(selectedFile);
      console.log('File details:', selectedFile);
    } catch (error) {
      if (error.code !== 'CANCELLED') {
        Alert.alert('Error', error.message);
      }
    }
  };

  return (
    <View style={styles.container}>
      <Button title="Pick File from Drive / Storage" onPress={handlePickFile} />
      {file && (
        <View style={styles.details}>
          <Text style={styles.label}>Selected File:</Text>
          <Text>{file.name}</Text>
          <Text style={styles.uri}>{file.uri}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  details: { marginTop: 15 },
  label: { fontWeight: 'bold' },
  uri: { fontSize: 10, color: '#666', marginTop: 4 },
});

```