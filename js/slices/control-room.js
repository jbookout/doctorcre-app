export default {
  "id": "control-room",
  "files": [
    "test/control-room-merge.test.mjs",
    "test/control-room-workspace.test.mjs",
    "test/control-room-workspace-browser.test.mjs",
    "test/job-detail-regressions.test.mjs",
    "control-room.html",
    "observatory.html",
    "js/observatory.js",
    "js/observatory-model.js",
    "css/observatory.css",
    "test/observatory-model.test.mjs",
    "test/observatory-browser.test.mjs",
    "test/observatory-review.test.mjs",
    "automations.html",
    "js/automations-list.js",
    "js/job-detail.js",
    "js/control-room-workspace-model.js",
    "js/connections-model.js",
    "css/control-room-workspace.css",
    "css/control-room.css",
    "js/atlas.js",
    "js/control-room.js",
    "js/model-room-model.js",
    "js/model-room.js",
    "js/sessions-model.js",
    "js/sessions.js",
    "test/atlas-anatomy.test.mjs",
    "test/atlas-incidents.test.mjs",
    "test/control-room-incomplete-badge.test.mjs",
    "test/model-room.test.mjs",
    "test/resource-dashboard.test.mjs",
    "test/sessions.test.mjs"
  ],
  "navigation": [
    {
      "label": "Control Room",
      "href": "/control-room",
      "order": 5
    },
    { "label": "Observatory", "href": "/control-room/observatory", "group": "Operations", "order": 17 }
  ],
  "activeRoutes": {"/control-room/progress":"/control-room", "/control-room/automations":"/control-room", "/control-room/observatory":"/control-room"},
  "sections": []
};
