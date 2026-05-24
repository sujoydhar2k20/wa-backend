# Firebase Cloud Messaging (FCM) Integration Guide for Mobile Developers

This document serves as an integration handbook for native mobile app developers (iOS, Android, Flutter, React Native) to configure, subscribe, and handle push notifications within the Whatsapp Bot & Staff Handling app using FCM.

---

## 1. Architecture Overview

The backend has transitioned from a VAPID Web Push architecture to a centralized Firebase Cloud Messaging (FCM) notification service. 
- When a staff user logs into the mobile app, the app should request push notification permissions and fetch the device's **FCM Registration Token**.
- The app must then call the backend registration endpoint to associate this FCM token with the logged-in staff user's MongoDB record.
- The backend utilizes Firebase Admin SDK to dispatch notifications via multicast to all registered device tokens for a particular user.
- If a token is marked as invalid, unregistered, or expired by Google FCM, the backend automatically purges that token from the user's database entry.

---

## 2. API Endpoints

All endpoints are hosted on the backend server under the `/api` prefix. Requests to these endpoints require a valid JWT token passed in the `Authorization` header.

### A. Subscribe Device Token
Send the FCM token to this endpoint after retrieving it on device startup, when the user grants permission, or when the token is refreshed.

* **URL:** `/api/push/subscribe`
* **Method:** `POST`
* **Headers:**
  - `Content-Type: application/json`
  - `Authorization: Bearer <JWT_ACCESS_TOKEN>`
* **Request Body:**
  ```json
  {
    "token": "YOUR_FCM_REGISTRATION_TOKEN_HERE"
  }
  ```
* **Success Response (201 Created):**
  ```json
  {
    "success": true,
    "message": "FCM registration token saved successfully"
  }
  ```
* **Error Response (400 Bad Request):**
  ```json
  {
    "error": "FCM registration token is required and must be a string"
  }
  ```

---

### B. Unsubscribe Device Token
Call this endpoint when the user logs out of the app, or toggles "Disable Notifications" in settings. This ensures they stop receiving messages on this specific device.

* **URL:** `/api/push/unsubscribe`
* **Method:** `POST`
* **Headers:**
  - `Content-Type: application/json`
  - `Authorization: Bearer <JWT_ACCESS_TOKEN>`
* **Request Body:**
  ```json
  {
    "token": "YOUR_FCM_REGISTRATION_TOKEN_HERE"
  }
  ```
* **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "FCM token removed successfully"
  }
  ```

---

## 3. FCM Payload Structure

When the backend sends a push notification, it specifies both standard `notification` fields (for system tray rendering) and `data` fields (for custom application handling or when in foreground).

### Example JSON Payload Delivered by FCM:
```json
{
  "notification": {
    "title": "New Chat Assigned",
    "body": "You have been assigned a new WhatsApp conversation with +1234567890"
  },
  "data": {
    "title": "New Chat Assigned",
    "body": "You have been assigned a new WhatsApp conversation with +1234567890",
    "url": "/dashboard/chats/12345abcde",
    "custom_field": "custom_value"
  }
}
```

### Key Elements:
1. **`notification.title` & `notification.body`**: Handled automatically by the mobile OS to show a notification in the system drawer when the application is backgrounded or terminated.
2. **`data.url`**: Contains the relative routing URL of the action to open when the notification is tapped. Use this to deep-link the staff member to the specific chat or page.

---

## 4. Integration Code Snippets

### A. React Native (using `@react-native-firebase/messaging`)
```javascript
import messaging from '@react-native-firebase/messaging';
import axios from 'axios';

// 1. Request User Permission
async function requestUserPermission() {
  const authStatus = await messaging().requestPermission();
  const enabled =
    authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
    authStatus === messaging.AuthorizationStatus.PROVISIONAL;

  if (enabled) {
    console.log('Authorization status:', authStatus);
    await registerFCMToken();
  }
}

// 2. Fetch and Subscribe Token
async function registerFCMToken() {
  try {
    const fcmToken = await messaging().getToken();
    if (fcmToken) {
      console.log('FCM Token:', fcmToken);
      // Post token to backend
      await axios.post('https://backend.biswakarmagold.com/api/push/subscribe', 
        { token: fcmToken },
        { headers: { Authorization: `Bearer ${userJwtToken}` } }
      );
    }
  } catch (error) {
    console.error('Error registering FCM token:', error);
  }
}

// 3. Listen for token refreshes
messaging().onTokenRefresh(async token => {
  console.log('Token refreshed:', token);
  await axios.post('https://backend.biswakarmagold.com/api/push/subscribe', 
    { token: token },
    { headers: { Authorization: `Bearer ${userJwtToken}` } }
  );
});
```

### B. Flutter (using `firebase_messaging`)
```dart
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

class PushNotificationService {
  final FirebaseMessaging _fcm = FirebaseMessaging.instance;

  Future<void> initialize(String jwtToken) async {
    // 1. Request Permission
    NotificationSettings settings = await _fcm.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );

    if (settings.authorizationStatus == AuthorizationStatus.authorized) {
      // 2. Get Token
      String? token = await _fcm.getToken();
      if (token != null) {
        await _subscribeToBackend(token, jwtToken);
      }

      // 3. Listen to token refreshes
      _fcm.onTokenRefresh.listen((token) async {
        await _subscribeToBackend(token, jwtToken);
      });
    }
  }

  Future<void> _subscribeToBackend(String token, String jwtToken) async {
    final response = await http.post(
      Uri.parse('https://backend.biswakarmagold.com/api/push/subscribe'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $jwtToken',
      },
      body: jsonEncode({'token': token}),
    );
    if (response.statusCode == 201) {
      print('FCM token registered successfully');
    }
  }
}
```

---

## 5. Mobile Integration Checklist & Best Practices

1. **Token Refresh Listener:** Ensure you attach a listener to handle FCM token refreshes. If the FCM token changes while the user is logged in, register the new token immediately to avoid missing notifications.
2. **Handle Logout:** On logout, fetch the current FCM token and send it to the `/api/push/unsubscribe` endpoint *before* clearing the local JWT token. This prevents the device from continuing to receive notifications intended for the previous user.
3. **Deep Linking:** Inspect the `data.url` property in the incoming push payload on notification tap, and route the user to the corresponding screen inside the app.
4. **App in Foreground:** When the app is in the foreground, FCM notification payloads do not automatically display as a banner. Render a custom alert, snackbar, or handle it silently as desired.
