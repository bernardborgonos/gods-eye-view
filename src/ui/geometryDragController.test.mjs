import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGeodesicCentroid,
  translateCoordinates,
  GeometryDragController,
} from './geometryDragController.js';

test('computeGeodesicCentroid calculates average vertex point for array coordinates', () => {
  const coords = [
    [-122.4, 37.8],
    [-122.2, 37.8],
    [-122.2, 38.0],
    [-122.4, 38.0],
  ];

  const centroid = computeGeodesicCentroid(coords);
  assert.equal(centroid.lng, -122.3);
  assert.equal(centroid.lat, 37.9);
  assert.equal(centroid.alt, 0);
});

test('computeGeodesicCentroid calculates average vertex point for object coordinates', () => {
  const coords = [
    { lng: -100.0, lat: 30.0, alt: 10 },
    { lng: -100.0, lat: 40.0, alt: 20 },
    { lng: -90.0, lat: 40.0, alt: 30 },
    { lng: -90.0, lat: 30.0, alt: 40 },
  ];

  const centroid = computeGeodesicCentroid(coords);
  assert.equal(centroid.lng, -95.0);
  assert.equal(centroid.lat, 35.0);
  assert.equal(centroid.alt, 25);
});

test('translateCoordinates applies deltas equally across array coordinates preserving shape', () => {
  const coords = [
    [-122.4, 37.8],
    [-122.2, 37.8],
    [-122.2, 38.0],
  ];

  const deltaLng = 1.5;
  const deltaLat = -2.2;

  const translated = translateCoordinates(coords, deltaLng, deltaLat);

  assert.deepEqual(translated, [
    [-120.9, 35.6],
    [-120.7, 35.6],
    [-120.7, 35.8],
  ]);
});

test('translateCoordinates applies deltas equally across object coordinates preserving shape', () => {
  const coords = [
    { lng: -122.4, lat: 37.8, alt: 100 },
    { lng: -122.2, lat: 37.8, alt: 100 },
    { lng: -122.2, lat: 38.0, alt: 100 },
  ];

  const deltaLng = -0.5;
  const deltaLat = 0.5;

  const translated = translateCoordinates(coords, deltaLng, deltaLat);

  assert.deepEqual(translated, [
    { lng: -122.9, lat: 38.3, alt: 100 },
    { lng: -122.7, lat: 38.3, alt: 100 },
    { lng: -122.7, lat: 38.5, alt: 100 },
  ]);
});

test('translateCoordinates supports lon property variant', () => {
  const coords = [
    { lon: 10.0, lat: 20.0 },
    { lon: 12.0, lat: 20.0 },
  ];

  const translated = translateCoordinates(coords, 1.0, 1.0);

  assert.deepEqual(translated, [
    { lon: 11.0, lat: 21.0 },
    { lon: 13.0, lat: 21.0 },
  ]);
});

test('onCommit and geofence bounding box recalculation callback triggers on release', () => {
  let committed = false;
  let committedCoords = null;
  let committedMode = null;
  let boundingBox = null;

  const mockViewer = {
    dataSources: {
      add: () => {},
      remove: () => {},
    },
    scene: {
      canvas: {},
      screenSpaceCameraController: { enableInputs: true },
    },
    clock: { currentTime: 0 },
  };

  const controller = new GeometryDragController(mockViewer, {
    onCommit: (coords, mode, item) => {
      committed = true;
      committedCoords = coords;
      committedMode = mode;

      // Calculate new bounding box for geofencing
      let minLng = Infinity, maxLng = -Infinity;
      let minLat = Infinity, maxLat = -Infinity;
      for (const c of coords) {
        const lng = Array.isArray(c) ? c[0] : (c.lng ?? c.lon);
        const lat = Array.isArray(c) ? c[1] : c.lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      boundingBox = { minLng, maxLng, minLat, maxLat };
    },
  });

  const testItem = {
    id: 'poly-1',
    coordinates: [
      [-122.4, 37.8],
      [-122.2, 37.8],
      [-122.2, 38.0],
    ],
  };

  controller.renderHandles(testItem);

  // Simulate drag state
  controller.dragState = {
    isDragging: true,
    dragMode: 'CENTROID',
    targetItem: testItem,
    currentCoordinates: translateCoordinates(testItem.coordinates, 1.0, 1.0),
  };

  // Commit drag
  controller.commitDrag();

  assert.equal(committed, true);
  assert.equal(committedMode, 'CENTROID');
  assert.deepEqual(committedCoords, [
    [-121.4, 38.8],
    [-121.2, 38.8],
    [-121.2, 39.0],
  ]);
  assert.deepEqual(boundingBox, {
    minLng: -121.4,
    maxLng: -121.2,
    minLat: 38.8,
    maxLat: 39.0,
  });

  controller.destroy();
});
