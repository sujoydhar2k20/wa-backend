# Create Broadcast: Select WABA Account API

This document describes the API required for **Step 1: Account Selection** in the Create Broadcast flow.

---

## 1. REST API: Get Active WhatsApp Accounts

Retrieves a list of all configured WhatsApp Business Accounts (WABAs) and their verified phone numbers. The user selects which phone number to send the broadcast campaign from.

### **Endpoint**
`GET /api/wabas`

### **Headers**
| Header | Value | Description |
| :--- | :--- | :--- |
| `Authorization` | `Bearer <JWT_TOKEN>` | Required for authentication. |

### **Success Response (`200 OK`)**
```json
[
  {
    "_id": "60d5ecb8b392d700153d10a1",
    "wabaId": "101928374657281",
    "businessName": "Clean Luxury Brand",
    "isActive": true,
    "phoneNumbers": [
      {
        "phoneNumberId": "102938475610293",
        "phoneNumber": "+91 98044 92738",
        "displayName": "Support Line",
        "verifiedName": "Clean Luxury Support",
        "qualityRating": "GREEN",
        "isDefault": true,
        "messagingLimitTier": "TIER_1K",
        "messagingLimit": 1000
      }
    ],
    "createdAt": "2026-05-18T10:00:00.000Z",
    "updatedAt": "2026-05-18T10:00:00.000Z"
  }
]
```

---

## 2. Frontend Binding Guide

To render the list of available channels on this screen:
1. Call `GET /api/wabas`.
2. Flatten the results by iterating through the `phoneNumbers` array of each active WABA (where `isActive` is `true`).
3. For each phone number, render a selection card containing:
   * **Phone Number**: The `phoneNumber` string (e.g. `+91 98044 92738`).
   * **Display Name**: (Optional) The `verifiedName` or `displayName` field.
4. **Selected State**: When the user clicks **Continue**, store the following values in your state machine to pass to the next steps:
   * `wabaId`: The parent WABA's database ID (`_id` field) or string ID (`wabaId`).
   * `phoneNumberId`: The chosen number's `phoneNumberId` (e.g., `102938475610293`).
