# WhatsApp Bot & CRM — Contact Info Sidebar API Reference

This document describes the API endpoints, request/response models, and filter patterns supporting the **Contact Info** sidebar in the chat layout.

---

## 1. Authentication

All requests require a valid JSON Web Token (JWT) in the authorization header:
```http
Authorization: Bearer <your_jwt_token>
```

---

## 2. API Endpoints

### 2.1 Fetch Chat & Contact Details
Retrieves the active chat session along with populated contact data, tags, and assigned staff details.

* **Endpoint:** `GET /chats/:chatId`
* **Method:** `GET`
* **Response (200 OK):**
  ```json
  {
    "_id": "65ab34cd56ef789012abcdef",
    "phoneNumber": "923154239421",
    "waId": "923154239421",
    "status": "open",
    "isUnread": false,
    "assignedTo": {
      "_id": "65ab12cd34ef567890abcdef",
      "name": "Rahul Poddar",
      "phone": "+919876543210"
    },
    "contactId": {
      "_id": "65ab567890abcdef12cd34ef",
      "phoneNumber": "923154239421",
      "waId": "923154239421",
      "name": "Muneeb Ehsan",
      "nickname": "Muneeb",
      "profilePicture": "https://example.com/profiles/muneeb.jpg",
      "isOptedOut": false,
      "isBlocked": false,
      "customFields": {}
    },
    "tags": [
      {
        "_id": "65ab90ab12cd34ef567890de",
        "name": "VIP Customer",
        "color": "#FFD700"
      }
    ],
    "isDnd": false,
    "lastMessageAt": "2026-05-29T07:30:00.000Z"
  }
  ```

---

### 2.2 Edit Contact Details (Name/Nickname)
Edits the name or nickname of the WhatsApp contact.

* **Endpoint:** `PUT /contacts/:contactId`
* **Method:** `PUT`
* **Request Body:**
  ```json
  {
    "name": "Muneeb Ehsan New",
    "nickname": "Muneeb"
  }
  ```
* **Response (200 OK):** Returns the updated `Contact` object.

---

### 2.3 Agent Assignment
Assigns or unassigns the conversation to a staff member.

* **Endpoint:** `POST /chats/:chatId/assign`
* **Method:** `POST`
* **Request Body:**
  ```json
  {
    "staffId": "65ab12cd34ef567890abcdef" // Send null or empty string to unassign
  }
  ```
* **Response (200 OK):** Returns the fully populated and updated `Chat` object.
* **Socket Event Broadcasted:** 
  - `chat:assigned` (broadcasted to all clients to refresh lists)
  - `chat:assigned:me` (broadcasted to the assigned agent's personal room `user:<userId>`)

---

### 2.4 Toggle Preferences

#### A. Do Not Disturb (DND)
Mutes in-app/push alerts specifically for this conversation.

* **Endpoint:** `PATCH /chats/:chatId/dnd`
* **Method:** `PATCH`
* **Request Body:**
  ```json
  {
    "isDnd": true // or false to unmute
  }
  ```
* **Response (200 OK):** Returns the updated `Chat` object.

#### B. Opt-out (News / Marketing Subscriptions)
Enables opt-out/in preferences for marketing and promotional broadcasts.

* **Opt-Out (Stop News):**
  * **Endpoint:** `POST /contacts/:contactId/opt-out`
  * **Method:** `POST`
  * **Response (200 OK):** Returns the updated `Contact` object with `isOptedOut: true`.

* **Opt-In (Subscribe to News):**
  * **Endpoint:** `POST /contacts/:contactId/opt-in`
  * **Method:** `POST`
  * **Response (200 OK):** Returns the updated `Contact` object with `isOptedOut: false`.

#### C. Block Contact
Blocks or unblocks the customer from sending messages.

* **Endpoint:** `POST /contacts/:contactId/block`
* **Method:** `POST`
* **Request Body:**
  ```json
  {
    "blocked": true // or false to unblock
  }
  ```
* **Response (200 OK):** Returns the updated `Contact` object with `isBlocked: true` (or `false`).

---

### 2.5 Tag Management

#### A. Add Tag to Conversation
Assigns a label/tag to a chat.

* **Endpoint:** `POST /tags/chats/:chatId/tags/:tagId`
* **Method:** `POST`
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "chat": {
      "_id": "65ab34cd56ef789012abcdef",
      "tags": [
        { "_id": "65ab90ab12cd34ef567890de", "name": "VIP Customer", "color": "#FFD700" }
      ]
    }
  }
  ```

#### B. Remove Tag from Conversation
Removes a label/tag from a chat.

* **Endpoint:** `DELETE /tags/chats/:chatId/tags/:tagId`
* **Method:** `DELETE`
* **Response (200 OK):** Returns success status and populated tags array.

---

### 2.6 Shared Media & Documents
Shared files are filtered client-side directly from the messages list of the conversation.

1. Fetch messages list via:
   * `GET /chats/:chatId/messages?page=1&limit=50`
2. Filter the messages array:
   * **Shared Media (Images/Videos):** `messages.filter(m => m.type === 'image' || m.type === 'video')`
   * **Documents:** `messages.filter(m => m.type === 'document')`

---

### 2.7 Automated Messages
Retrieves bot-sent automated replies (Bot flow answers, OCR code detections, text code matches) for the chat session.

* **Endpoint:** `GET /chats/:chatId/auto-messages`
* **Method:** `GET`
* **Query Parameters:**
  - `page`: Page index (default: `1`)
  - `limit`: Items per page (default: `50`)
* **Response (200 OK):**
  ```json
  {
    "data": [
      {
        "_id": "65ab90bc56ef789012abcdef",
        "messageId": "ABGGFlK524abCD",
        "type": "text",
        "text": "Gold Ring weight is 4.5g.",
        "createdAt": "2026-05-29T07:28:00.000Z",
        "direction": "outbound",
        "source": "image_ocr", 
        "sourceLabel": "Image Code Detection",
        "sourceIcon": "image",
        "productCode": "GR-04",
        "productInfo": {
          "code": "GR-04",
          "name": "Gold Ring",
          "category": "Rings",
          "weight": 4.5
        }
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 50
  }
  ```
