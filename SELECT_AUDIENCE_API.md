# Create Broadcast: Select Audience APIs

This document describes the APIs required for **Step 2: Audience Selection** in the Create Broadcast flow. It covers retrieving tags, retrieving imported contacts, searching them, and importing new contact list files.

---

## 1. Tags Tab

### **1.1 List and Search Tags**
Retrieves available contact tags to choose the targeted audiences. Supports real-time query searching.

#### **Endpoint**
`GET /api/tags`

#### **Headers**
| Header | Value | Description |
| :--- | :--- | :--- |
| `Authorization` | `Bearer <JWT_TOKEN>` | Required for authentication. |

#### **Query Parameters (Optional)**
| Parameter | Type | Description |
| :--- | :--- | :--- |
| `search` / `q` | String | Live search term to filter tags by name. |

#### **Success Response (`200 OK`)**
```json
[
  {
    "_id": "60d5ecb8b392d700153d10tg1",
    "name": "Summer Leads",
    "color": "#FF5733",
    "description": "Leads from summer campaign",
    "createdAt": "2026-05-05T10:00:00.000Z",
    "updatedAt": "2026-05-05T10:00:00.000Z"
  }
]
```

---

## 2. Imported Contacts Tab

### **2.1 List and Search Broadcast Lists**
Retrieves imported contact lists (audiences) with pagination and live search functionality.

#### **Endpoint**
`GET /api/broadcast-lists`

#### **Headers**
| Header | Value | Description |
| :--- | :--- | :--- |
| `Authorization` | `Bearer <JWT_TOKEN>` | Required for authentication. |

#### **Query Parameters (Optional)**
| Parameter | Type | Description |
| :--- | :--- | :--- |
| `search` / `q` | String | Live search term to filter lists by name. |
| `wabaId` | String | Filter lists by WhatsApp Business Account database ID. |
| `page` | Number | Page number for pagination (default: `1`). |
| `limit` | Number | Items per page (default: `20`). |

#### **Success Response (`200 OK`)**
```json
{
  "data": [
    {
      "_id": "60d5ecb8b392d700153d10l1",
      "name": "VIP Customers List",
      "description": "Manually imported VIP list",
      "memberCount": 1235,
      "source": "import",
      "importedFile": "vip_contacts.csv",
      "createdAt": "2026-05-01T10:00:00.000Z",
      "updatedAt": "2026-05-01T10:00:00.000Z"
  }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

---

### **2.2 Create a New Broadcast List (Container)**
Creates a new list placeholder before importing CSV/Excel files or adding members.

#### **Endpoint**
`POST /api/broadcast-lists`

#### **Headers**
- `Authorization`: `Bearer <JWT_TOKEN>`

#### **Request Body**
```json
{
  "name": "Festive Season Contacts",
  "description": "Contacts imported for festival promos",
  "wabaId": "60d5ecb8b392d700153d10a1"
}
```

#### **Success Response (`201 Created`)**
```json
{
  "_id": "60d5ecb8b392d700153d10l2",
  "name": "Festive Season Contacts",
  "description": "Contacts imported for festival promos",
  "wabaId": "60d5ecb8b392d700153d10a1",
  "memberCount": 0,
  "createdAt": "2026-05-19T12:00:00.000Z"
}
```

---

### **2.3 Import Contacts via CSV / Text File**
Uploads a text or CSV file to add members to a specific list.

#### **Endpoint**
`POST /api/broadcast-lists/:id/import`

#### **Headers**
- `Authorization`: `Bearer <JWT_TOKEN>`
- `Content-Type`: `multipart/form-data`

#### **Request Body (Multipart Form)**
| Key | Type | Description |
| :--- | :--- | :--- |
| `file` | File | The CSV/TXT file to import. |
| `phoneColumn` | Number | 0-based index of the phone number column (default: `0`). |
| `nameColumn` | Number | 0-based index of the name column (optional, default: `-1`). |

#### **Success Response (`200 OK`)**
```json
{
  "success": true,
  "imported": 150,
  "total": 150
}
```

---

## 3. Frontend Binding Guide

* **Search Bar**:
  * If the active tab is **Tags**, call `GET /api/tags?search=<QUERY>`.
  * If the active tab is **Imported Contacts**, call `GET /api/broadcast-lists?search=<QUERY>`.
* **Selection State**:
  * For tags targeting: collect selected tag IDs into `tagIds` array.
  * For list targeting: collect selected list database ID into `broadcastListId`.
* **Continue Action**: Carry over selected IDs to step 3.
