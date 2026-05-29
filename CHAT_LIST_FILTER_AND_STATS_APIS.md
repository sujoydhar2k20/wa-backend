# WhatsApp Bot & CRM — Chat List Filters & Live Stats API Reference

This document describes the API endpoints, query parameters, and dropdown data sources supporting the **Chat List Sidebar** (My Chats, Unassigned, Team Member, Tags, and WABAs filters) and its dynamic counters.

---

## 1. Authentication

All requests require a valid JSON Web Token (JWT) in the authorization header:
```http
Authorization: Bearer <your_jwt_token>
```

---

## 2. Dynamic Counters (Live Stats)

To display counts next to the categories (e.g. `Closed: 6`, `All: 6`), call this stats endpoint. It dynamically recalculates counts based on any active filters applied in the dropdowns.

* **Endpoint:** `GET /chats/stats`
* **Method:** `GET`
* **Query Parameters (Optional Filters):**
  - `wabaId`: Filter counts by a specific WhatsApp Business Account.
  - `assignedTo`: Filter counts by assigned staff user ID (pass `"null"` to get unassigned counts).
  - `tagId` (or `tag`/`tags`): Filter counts by a specific Tag ID.
* **Response (200 OK):**
  ```json
  {
    "all": 6,
    "open": 0,
    "unread": 0,
    "closed": 6,
    "waiting": 0
  }
  ```

---

## 3. Filtered Chat List

To retrieve the list of conversations matching the selected category and active dropdown filters, call the main chats list endpoint.

* **Endpoint:** `GET /chats`
* **Method:** `GET`
* **Query Parameters:**
  - `page`: Page index (default: `1`)
  - `limit`: Items per page (default: `20`)
  - `status`: Filter by chat status (`"open"` or `"closed"`).
  - `isUnread`: Filter by unread status (`"true"` or `"false"`).
  - `isWaiting`: Filter by "Awaiting Reply" status (`"true"` or `"false"`).
  - `assignedTo`: Filter by assigned staff user ID (pass `"null"` to filter for unassigned chats).
  - `tagId` (or `tag`/`tags`): Filter chats by tag ID.
  - `wabaId`: Filter chats by WABA account ID.
* **Response (200 OK):**
  ```json
  {
    "data": [
      {
        "_id": "65ab34cd56ef789012abcdef",
        "phoneNumber": "923154239421",
        "status": "closed",
        "isUnread": false,
        "assignedTo": null,
        "wabaId": "65ab123456ef789012abcdef",
        "tags": []
      }
    ],
    "total": 6,
    "page": 1,
    "limit": 20
  }
  ```

---

## 4. Sidebar Dropdown Data Sources

To populate the filters (Team Member, Tags, and WABAs dropdowns), call these metadata endpoints:

### 4.1 Filter by Member Dropdown
Retrieves all users/staff members to populate the assignment filter list.

* **Endpoint:** `GET /users`
* **Method:** `GET`
* **Response (200 OK):** Returns an array of user objects:
  ```json
  [
    { "_id": "65ab12cd34ef567890abcdef", "name": "Rahul Poddar", "phone": "923154239421", "role": "staff" },
    { "_id": "65ab67890abcdef12cd34ef0", "name": "BJS Super Admin", "phone": "923001234567", "role": "superadmin" }
  ]
  ```

### 4.2 Filter by Tags Dropdown
Retrieves all active labels/tags configured in the system.

* **Endpoint:** `GET /tags`
* **Method:** `GET`
* **Response (200 OK):** Returns an array of tag objects:
  ```json
  [
    { "_id": "65ab90ab12cd34ef567890de", "name": "VIP Customer", "color": "#FFD700" }
  ]
  ```

### 4.3 Filter by WABAs Dropdown
Retrieves the connected WhatsApp Business Accounts (phone numbers and business names).

* **Endpoint:** `GET /wabas`
* **Method:** `GET`
* **Response (200 OK):** Returns an array of WABA configuration objects:
  ```json
  [
    {
      "_id": "65ab123456ef789012abcdef",
      "businessName": "Baba New 9804",
      "phoneNumbers": [
        { "verifiedName": "Baba New 9804", "displayPhoneNumber": "+91 98044 92738" }
      ]
    }
  ]
  ```
