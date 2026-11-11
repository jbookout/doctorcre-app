import type { CoordinateReview } from "../../../src/ui/tour-coordinate-review-contract.ts";
import { parseCoordinateReview } from "../../../src/ui/tour-coordinate-review-model.ts";
import { detailFixture } from "../tour-navigation/detail.ts";
export function coordinateDetailFixture() {
  const detail = detailFixture();
  const stops = detail.stops.map((stop, index) => {
    const review: CoordinateReview = {
      schema: "tour-coordinate-review.v1",
      property_id: stop.property_id,
      property_name: `Synthetic Medical ${index + 1}`,
      property_address: `${100 + index} Test Street`,
      as_of: new Date().toISOString(),
      status: "candidates",
      reason: null,
      property_evidence: [],
      candidates: [
        {
          coordinate_candidate_id: `candidate-${index}`,
          property_id: stop.property_id,
          coordinate_role: "entrance",
          precision_class: "entrance",
          observed_at: new Date().toISOString(),
          review_state: "reviewed",
          position: { latitude: 30.422, longitude: -87.216 },
          access_notes: "East driveway",
          source: {
            source_evidence_id: "source-1",
            provider: "Synthetic site plan",
            stable_locator: "https://example.com/site",
            retrieved_at: null,
            retrieval_status: "read",
          },
          rights: {
            rights_receipt_id: "rights-1",
            status: "usable",
            provider: "Synthetic",
            policy_key: null,
            receipt_version: 1,
            terms_url: null,
            allowed_use_classes: ["internal_review"],
            allowed_field_classes: ["coordinates"],
            effective_at: null,
            expires_at: null,
            revoked_at: null,
            receipt_status: "active",
          },
          approval: { status: "unverified", receipt: null },
        },
        {
          coordinate_candidate_id: `centroid-${index}`,
          property_id: stop.property_id,
          coordinate_role: "parcel_centroid",
          precision_class: "parcel",
          observed_at: new Date().toISOString(),
          review_state: "unreviewed",
          position: null,
          access_notes: null,
          source: {
            source_evidence_id: "source-2",
            provider: "Synthetic restricted source",
            stable_locator: null,
            retrieved_at: null,
            retrieval_status: "read",
          },
          rights: {
            rights_receipt_id: "rights-2",
            status: "unavailable",
            provider: "Synthetic",
            policy_key: null,
            receipt_version: 1,
            terms_url: null,
            allowed_use_classes: null,
            allowed_field_classes: null,
            effective_at: null,
            expires_at: null,
            revoked_at: new Date().toISOString(),
            receipt_status: "revoked",
          },
          approval: { status: "rights_unavailable", receipt: null },
        },
      ],
    };
    const source = detail.routes[0]?.navigation.evidence.stops[index];
    const approved = review.candidates[0];
    if (!source || !approved) throw Error("Missing navigation fixture");
    approved.position = source.position;
    approved.coordinate_candidate_id = source.source.coordinate_candidate_id;
    approved.source.source_evidence_id = source.source.source_evidence_id;
    approved.source.stable_locator = source.source.stable_locator;
    approved.rights.rights_receipt_id = source.source.rights_receipt_id;
    approved.approval = {
      status: "verified_entrance",
      receipt: {
        verification_receipt_id: source.source.entrance_verification_receipt_id,
        verifier_actor_id: source.source.verifier_actor_id,
        verified_at: source.source.verified_at,
        evidence_reference: source.source.evidence_reference,
        receipt_digest: source.source.receipt_digest,
        native_navigation_proof: source.source.native_navigation_proof,
      },
    };
    review.candidates.push({
      ...structuredClone(approved),
      coordinate_candidate_id: "unverified-" + index,
      approval: { status: "unverified", receipt: null },
    });
    if (!parseCoordinateReview(review, stop.property_id)) throw Error("Fixture does not satisfy pinned contract");
    return { ...stop, coordinate_review: review };
  });
  return { ...detail, stops, routes: detail.routes.map((route) => ({ ...route, stops })) };
}
