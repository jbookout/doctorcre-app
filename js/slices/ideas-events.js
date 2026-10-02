export default {
  "id": "ideas-events",
  "files": [
    "css/ideas.css",
    "ideas.html",
    "js/ideas-model.js",
    "js/ideas.js",
    "test/ideas.test.mjs"
  ],
  "navigation": [
    {
      "label": "Ideas",
      "href": "/ideas-events?tab=ideas",
      "group": "Workspace",
      "order": 8
    },
    {
      "label": "Events",
      "href": "/ideas-events?tab=events",
      "group": "Workspace",
      "order": 9
    }
  ],
  "activeRoutes": {
    "/ideas": "/ideas-events?tab=ideas"
  },
  "sections": []
};
