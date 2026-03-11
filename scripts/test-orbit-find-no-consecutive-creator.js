#!/usr/bin/env node
"use strict";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildCandidate({
  id,
  creatorId,
  score,
  seenInSession = false,
  bucket = "exploration",
}) {
  return {
    row: { id, userId: creatorId },
    id,
    creatorId,
    primaryTopic: "",
    bucket,
    recentlyViewed: false,
    seenInSession,
    viralScore: 0.5,
    qualityPassed: true,
    finalScore: score,
    scoreBreakdown: {
      relevance: 0,
      watch: 0,
      interests: 0,
      freshness: 0,
      social: 0,
      quality: 0,
      novelty: 0,
      exploration: 0,
      trending: 0,
      weightedBase: 0,
      creatorPenalty: 0,
      topicPenalty: 0,
      fatiguePenalty: 0,
      lowQualityPenalty: 0,
    },
  };
}

function buildEmptySessionState() {
  return {
    updatedAt: Date.now(),
    seenReelIds: [],
    recentCreatorIds: [],
    recentPrimaryTopics: [],
    creatorImpressions: {},
  };
}

function run() {
  // Ensure we can load the already-compiled backend module.
  // Run `npm run build` first if dist is outdated.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const reelRepo = require("../dist/repository/reel/reel_repository");
  const selectOrbitCandidates = reelRepo.__selectOrbitCandidatesForTest;
  assert(
    typeof selectOrbitCandidates === "function",
    "Missing __selectOrbitCandidatesForTest export"
  );

  const scoredCandidates = [
    buildCandidate({ id: 101, creatorId: 1, score: 1.0, seenInSession: false }),
    buildCandidate({ id: 102, creatorId: 1, score: 0.95, seenInSession: false }),
    buildCandidate({ id: 201, creatorId: 2, score: 0.9, seenInSession: true }),
  ];

  const selected = selectOrbitCandidates({
    scoredCandidates,
    desiredCount: 2,
    bucketTargets: {
      affinity: 0,
      trending: 0,
      social: 0,
      exploration: 2,
    },
    sessionState: buildEmptySessionState(),
  });

  assert(Array.isArray(selected), "Expected selected to be an array");
  assert(selected.length === 2, `Expected 2 items, received ${selected.length}`);
  assert(selected[0].creatorId === 1, "Expected first candidate to be creator 1");
  assert(
    selected[1].creatorId === 2,
    `Expected second candidate to be creator 2 to avoid consecutive repeat; got creator ${selected[1].creatorId}`
  );
  assert(
    selected[0].creatorId !== selected[1].creatorId,
    "Detected consecutive same-creator selection despite alternative creator"
  );

  const sameCreatorCandidate = scoredCandidates.find((c) => c.id === 102);
  assert(
    sameCreatorCandidate &&
      sameCreatorCandidate.excludedReason === "same_creator_consecutive_blocked",
    `Expected excludedReason=same_creator_consecutive_blocked for id=102, got ${sameCreatorCandidate?.excludedReason}`
  );

  const onlyOneCreatorCandidates = [
    buildCandidate({ id: 301, creatorId: 3, score: 1.0, seenInSession: false }),
    buildCandidate({ id: 302, creatorId: 3, score: 0.92, seenInSession: false }),
  ];

  const selectedSingleCreator = selectOrbitCandidates({
    scoredCandidates: onlyOneCreatorCandidates,
    desiredCount: 2,
    bucketTargets: {
      affinity: 0,
      trending: 0,
      social: 0,
      exploration: 2,
    },
    sessionState: buildEmptySessionState(),
  });

  assert(
    selectedSingleCreator.length === 2,
    `Expected 2 items for single-creator pool, got ${selectedSingleCreator.length}`
  );
  assert(
    selectedSingleCreator[0].creatorId === 3 && selectedSingleCreator[1].creatorId === 3,
    "Expected fallback to allow same creator when no alternative creator exists"
  );

  console.log(
    "[pass] Orbit reranker blocks same-creator consecutive with alternatives and allows fallback without alternatives"
  );
}

try {
  run();
} catch (error) {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
}
