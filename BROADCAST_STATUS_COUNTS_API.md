# Broadcast Status Counts API & WebSockets

This document describes the API and real-time WebSocket events required to power the **Broadcast Module** landing screen.

---

## 1. REST API: Get Broadcast Status Counts

Retrieves the aggregated number of broadcast campaigns in each lifecycle state. This is used to display the count badges next to the **Drafts**, **Scheduled**, and **Completed** category lists.

### **Endpoint**
`GET /api/broadcasts/status-counts`

### **Headers**
| Header | Value | Description |
| :--- | :--- | :--- |
| `Authorization` | `Bearer <JWT_TOKEN>` | Required for authentication. |

### **Query Parameters (Optional)**
| Parameter | Type | Description |
| :--- | :--- | :--- |
| `wabaId` | String | Filter counts by a specific WhatsApp Business Account (WABA) ID. |

### **Success Response (`200 OK`)**
```json
{
  "success": true,
  "data": {
    "draft": 5,
    "scheduled": 2,
    "completed": 12,
    "sending": 0,
    "paused": 0,
    "failed": 0,
    "total": 17
  }
}
```

### **Field Mapping for the Screen**
* **Drafts Row**: Bind the value of `data.draft` (e.g. `Drafts (5)`)
* **Scheduled Row**: Bind the value of `data.scheduled` (e.g. `Scheduled (2)`)
* **Completed Row**: Bind the value of `data.completed` (e.g. `Completed (12)`)

---

## 2. Real-Time WebSockets (`Socket.IO`)

To keep the category counts live and responsive (without requiring manual page refreshes or polling), listen to the `broadcast:update` event.

### **Connection Setup**
* **Socket Namespace/Server**: Connect to your Socket.IO host URL (`wss://<YOUR_BACKEND_URL>`).
* **Auth**: Pass the authentication token in the handshakes.

### **Event Details**
* **Event Name to Listen To**: `broadcast:update`
* **Trigger**: Fired by the server whenever a broadcast campaign transitions between statuses (e.g., from `scheduled` to `sending` or `completed`), or gets updated.
* **Payload**:
  ```json
  {
    "_id": "60d5ecb8b392d700153d10b1",
    "status": "completed",
    "statistics": {
      "total": 1235,
      "sent": 1235,
      "delivered": 600,
      "read": 300,
      "replied": 10,
      "failed": 0
    }
  }
  ```

### **Recommended Client Handling**
When the `broadcast:update` event is received:
1. Trigger a silent background call to the `GET /api/broadcasts/status-counts` endpoint to fetch the updated numbers.
2. Update the local UI state dynamically with the new count values for a seamless, live user experience.
