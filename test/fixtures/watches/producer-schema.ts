export const subjectWatchV2ResponseSchema = {
  "type": "object",
  "required": [
    "ok",
    "schema_version"
  ],
  "properties": {
    "ok": {
      "const": true
    },
    "schema_version": {
      "const": "subject-watch.v2"
    },
    "health": {
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "last_success_at",
        "pending_count",
        "oldest_pending_at",
        "status"
      ],
      "properties": {
        "last_success_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        },
        "oldest_pending_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time"
        },
        "pending_count": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1001
        },
        "status": {
          "enum": [
            "healthy",
            "delayed",
            "needs_repair"
          ]
        }
      }
    },
    "watch": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "actor_id",
            "subject_type",
            "subject_id",
            "state",
            "policy",
            "lifecycle_version",
            "baseline",
            "subscribed_at"
          ],
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
            },
            "actor_id": {
              "type": "string",
              "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
            },
            "subject_id": {
              "type": "string",
              "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
            },
            "subject_type": {
              "enum": [
                "deal",
                "lease",
                "listing"
              ]
            },
            "state": {
              "enum": [
                "watching",
                "paused",
                "removed"
              ]
            },
            "policy": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "change_kinds": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 3,
                  "uniqueItems": true,
                  "items": {
                    "type": "string",
                    "enum": [
                      "reply_arrived",
                      "lease_threshold_crossed",
                      "listing_status_changed"
                    ]
                  }
                },
                "include_self_changes": {
                  "type": "boolean",
                  "default": true
                },
                "lease_threshold_months": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 20,
                  "uniqueItems": true,
                  "items": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 120
                  }
                },
                "lease_threshold_days": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 20,
                  "uniqueItems": true,
                  "items": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 3650
                  }
                }
              },
              "required": [
                "change_kinds",
                "include_self_changes"
              ]
            },
            "lifecycle_version": {
              "type": "integer",
              "minimum": 1
            },
            "baseline": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "schema_version",
                "subject_type",
                "subject_id",
                "version"
              ],
              "properties": {
                "schema_version": {
                  "const": "subject-watch-baseline.v1"
                },
                "subject_type": {
                  "enum": [
                    "deal",
                    "lease",
                    "listing"
                  ]
                },
                "subject_id": {
                  "type": "string",
                  "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
                },
                "version": {
                  "type": "integer",
                  "minimum": 1
                }
              }
            },
            "subscribed_at": {
              "type": "string",
              "format": "date-time"
            }
          }
        },
        {
          "type": "null"
        }
      ]
    },
    "watches": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "actor_id",
          "subject_type",
          "subject_id",
          "state",
          "policy",
          "lifecycle_version",
          "baseline",
          "subscribed_at"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
          },
          "actor_id": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
          },
          "subject_id": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
          },
          "subject_type": {
            "enum": [
              "deal",
              "lease",
              "listing"
            ]
          },
          "state": {
            "enum": [
              "watching",
              "paused",
              "removed"
            ]
          },
          "policy": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "change_kinds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 3,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "enum": [
                    "reply_arrived",
                    "lease_threshold_crossed",
                    "listing_status_changed"
                  ]
                }
              },
              "include_self_changes": {
                "type": "boolean",
                "default": true
              },
              "lease_threshold_months": {
                "type": "array",
                "minItems": 1,
                "maxItems": 20,
                "uniqueItems": true,
                "items": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 120
                }
              },
              "lease_threshold_days": {
                "type": "array",
                "minItems": 1,
                "maxItems": 20,
                "uniqueItems": true,
                "items": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 3650
                }
              }
            },
            "required": [
              "change_kinds",
              "include_self_changes"
            ]
          },
          "lifecycle_version": {
            "type": "integer",
            "minimum": 1
          },
          "baseline": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "schema_version",
              "subject_type",
              "subject_id",
              "version"
            ],
            "properties": {
              "schema_version": {
                "const": "subject-watch-baseline.v1"
              },
              "subject_type": {
                "enum": [
                  "deal",
                  "lease",
                  "listing"
                ]
              },
              "subject_id": {
                "type": "string",
                "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
              },
              "version": {
                "type": "integer",
                "minimum": 1
              }
            }
          },
          "subscribed_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    },
    "rows_changed": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1
    },
    "has_more": {
      "type": "boolean"
    },
    "next_cursor": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "oneOf": [
    {
      "required": [
        "watch"
      ]
    },
    {
      "required": [
        "watches",
        "has_more",
        "next_cursor"
      ]
    }
  ]
};
