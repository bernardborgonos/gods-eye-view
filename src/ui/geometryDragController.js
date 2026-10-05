import * as Cesium from 'cesium';

/**
 * Computes the geodesic centroid (vertex mean) for a polygon or polyline.
 * Handles both object coordinates [{lng, lat, alt}] / [{lon, lat}] and array coordinates [[lng, lat]].
 *
 * @param {Array<object|Array<number>>} coordinates - Array of coordinates.
 * @returns {{lng: number, lat: number, alt: number}} Centroid point object.
 */
export function computeGeodesicCentroid(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return { lng: 0, lat: 0, alt: 0 };
  }

  let totalLng = 0;
  let totalLat = 0;
  let totalAlt = 0;
  const count = coordinates.length;

  for (const coord of coordinates) {
    if (Array.isArray(coord)) {
      totalLng += Number(coord[0]) || 0;
      totalLat += Number(coord[1]) || 0;
      totalAlt += Number(coord[2]) || 0;
    } else if (coord && typeof coord === 'object') {
      totalLng += Number(coord.lng ?? coord.lon ?? 0) || 0;
      totalLat += Number(coord.lat ?? 0) || 0;
      totalAlt += Number(coord.alt ?? coord.height ?? 0) || 0;
    }
  }

  return {
    lng: Number((totalLng / count).toFixed(7)),
    lat: Number((totalLat / count).toFixed(7)),
    alt: Number((totalAlt / count).toFixed(2)),
  };
}

/**
 * Translates a set of coordinates by longitude and latitude deltas, preserving format.
 *
 * @param {Array<object|Array<number>>} coordinates - Input coordinates.
 * @param {number} deltaLng - Longitude delta in degrees.
 * @param {number} deltaLat - Latitude delta in degrees.
 * @returns {Array<object|Array<number>>} Translated coordinates.
 */
export function translateCoordinates(coordinates, deltaLng, deltaLat) {
  if (!Array.isArray(coordinates)) return [];

  return coordinates.map((coord) => {
    if (Array.isArray(coord)) {
      const newLng = Number((Number(coord[0] || 0) + deltaLng).toFixed(7));
      const newLat = Number((Number(coord[1] || 0) + deltaLat).toFixed(7));
      return coord.length > 2
        ? [newLng, newLat, coord[2]]
        : [newLng, newLat];
    } else if (coord && typeof coord === 'object') {
      const lngKey = 'lng' in coord ? 'lng' : ('lon' in coord ? 'lon' : 'lng');
      const currentLng = Number(coord[lngKey] || 0);
      const currentLat = Number(coord.lat || 0);
      return {
        ...coord,
        [lngKey]: Number((currentLng + deltaLng).toFixed(7)),
        lat: Number((currentLat + deltaLat).toFixed(7)),
      };
    }
    return coord;
  });
}

/**
 * 3-tier Cesium position resolution:
 * 1. scene.pickPosition(screenPosition) (3D Tiles / Depth buffer)
 * 2. scene.globe.pick(ray, scene) (Terrain)
 * 3. camera.pickEllipsoid(screenPosition, ellipsoid) (Ellipsoid fallback)
 *
 * @param {Cesium.Scene} scene - Cesium Scene.
 * @param {Cesium.Cartesian2} screenPosition - 2D Screen position.
 * @returns {Cesium.Cartographic|null} Resolved Cartographic position or null.
 */
export function resolveCartographicPosition(scene, screenPosition) {
  if (!scene || !screenPosition) return null;

  let cartesian = null;

  // Tier 1: 3D Tile / Depth picking
  if (scene.pickPositionSupported) {
    try {
      cartesian = scene.pickPosition(screenPosition);
    } catch {
      cartesian = null;
    }
  }

  // Tier 2: Globe Terrain picking
  if (!cartesian || !Cesium.defined(cartesian)) {
    try {
      const ray = scene.camera.getPickRay(screenPosition);
      if (ray && scene.globe) {
        cartesian = scene.globe.pick(ray, scene);
      }
    } catch {
      cartesian = null;
    }
  }

  // Tier 3: Ellipsoid fallback
  if (!cartesian || !Cesium.defined(cartesian)) {
    try {
      const ellipsoid = scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
      cartesian = scene.camera.pickEllipsoid(screenPosition, ellipsoid);
    } catch {
      cartesian = null;
    }
  }

  if (!cartesian || !Cesium.defined(cartesian)) return null;

  try {
    return Cesium.Cartographic.fromCartesian(cartesian);
  } catch {
    return null;
  }
}

/**
 * GeometryDragController manages the interaction state and handles for centroid (whole-polygon)
 * and vertex dragging on Cesium maps.
 */
export class GeometryDragController {
  /**
   * @param {Cesium.Viewer} viewer - Cesium Viewer.
   * @param {object} [options]
   * @param {Function} [options.onUpdate] - Live geometry update callback (coords, mode, item).
   * @param {Function} [options.onCommit] - Persistence callback on LEFT_UP release.
   */
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this.options = options;

    if (viewer?.dataSources) {
      this.dataSource = new Cesium.CustomDataSource('gev-geometry-drag-handles');
      this.viewer.dataSources.add(this.dataSource);
    } else {
      this.dataSource = null;
    }

    const canvas = viewer?.scene?.canvas;
    if (canvas && typeof globalThis.document !== 'undefined') {
      this.handler = new Cesium.ScreenSpaceEventHandler(canvas);
    } else {
      this.handler = null;
    }

    this.dragState = {
      isDragging: false,
      dragMode: null, // 'CENTROID' | 'VERTEX' | null
      itemId: null,
      targetItem: null,
      vertexIndex: null,
      lastCartographic: null,
      initialCoordinates: [],
      currentCoordinates: [],
    };

    this.activeItem = null;
    if (this.handler) {
      this._setupEventHandlers();
    }
  }

  /**
   * Renders the centroid badge handle ("✥ MOVE") and per-vertex handles for an item.
   *
   * @param {object} item - Tactical item or feature with coordinates and id.
   */
  renderHandles(item) {
    this.clearHandles();
    if (!item || !this.dataSource) return;

    const coords = item.coordinates || item.ring || item.positions;
    if (!Array.isArray(coords) || coords.length < 2) return;

    this.activeItem = item;
    const itemId = item.id || 'active-item';

    // 1. Calculate and render Centroid Handle ("✥ MOVE")
    const centroid = computeGeodesicCentroid(coords);
    const centroidCartesian = Cesium.Cartesian3.fromDegrees(centroid.lng, centroid.lat, centroid.alt || 0);

    this.dataSource.entities.add({
      id: `handle-centroid-${itemId}`,
      position: centroidCartesian,
      point: {
        pixelSize: 14,
        color: Cesium.Color.fromCssColorString('#ffb547'), // Amber
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '✥ MOVE',
        font: 'bold 12px "Inter", sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -12),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: new Cesium.PropertyBag({
        isHandle: true,
        handleType: 'CENTROID',
        itemId: itemId,
      }),
    });

    // 2. Render Per-Vertex Blue Handles
    coords.forEach((coord, idx) => {
      let lng = 0;
      let lat = 0;
      let alt = 0;

      if (Array.isArray(coord)) {
        lng = coord[0];
        lat = coord[1];
        alt = coord[2] || 0;
      } else if (coord && typeof coord === 'object') {
        lng = coord.lng ?? coord.lon ?? 0;
        lat = coord.lat ?? 0;
        alt = coord.alt ?? coord.height ?? 0;
      }

      const vertexCartesian = Cesium.Cartesian3.fromDegrees(lng, lat, alt);

      this.dataSource.entities.add({
        id: `handle-vertex-${itemId}-${idx}`,
        position: vertexCartesian,
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString('#39d0ff'), // Blue
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `V${idx + 1}`,
          font: '10px "Inter", sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: new Cesium.PropertyBag({
          isHandle: true,
          handleType: 'VERTEX',
          vertexIndex: idx,
          itemId: itemId,
        }),
      });
    });
  }

  /**
   * Clears all handles from the custom data source.
   */
  clearHandles() {
    if (this.dataSource) {
      this.dataSource.entities.removeAll();
    }
    this.activeItem = null;
  }

  /**
   * Triggers the commit action manually or upon release.
   */
  commitDrag() {
    if (!this.dragState.isDragging) return;

    const finalCoords = this.dragState.currentCoordinates;
    const targetItem = this.dragState.targetItem;
    const dragMode = this.dragState.dragMode;

    if (this.viewer?.scene?.screenSpaceCameraController) {
      this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    }

    this.dragState = {
      isDragging: false,
      dragMode: null,
      itemId: null,
      targetItem: null,
      vertexIndex: null,
      lastCartographic: null,
      initialCoordinates: [],
      currentCoordinates: [],
    };

    if (typeof this.options.onCommit === 'function' && targetItem) {
      this.options.onCommit(finalCoords, dragMode, targetItem);
    }
  }

  /**
   * Sets up Cesium mouse input actions (LEFT_DOWN, MOUSE_MOVE, LEFT_UP).
   * @private
   */
  _setupEventHandlers() {
    if (!this.handler) return;

    // LEFT_DOWN: Detect handle selection and start drag
    this.handler.setInputAction((click) => {
      if (!click?.position) return;

      const picked = this.viewer.scene.pick(click.position);
      if (!Cesium.defined(picked) || !picked.id || !picked.id.properties) return;

      const props = picked.id.properties;
      if (!props.getValue(this.viewer.clock.currentTime)?.isHandle) return;

      const handleType = props.getValue(this.viewer.clock.currentTime).handleType;
      const itemId = props.getValue(this.viewer.clock.currentTime).itemId;
      const vertexIndex = props.getValue(this.viewer.clock.currentTime).vertexIndex;

      if (!this.activeItem || (this.activeItem.id && this.activeItem.id !== itemId)) return;

      const startPos = resolveCartographicPosition(this.viewer.scene, click.position);
      if (!startPos) return;

      if (this.viewer.scene?.screenSpaceCameraController) {
        this.viewer.scene.screenSpaceCameraController.enableInputs = false;
      }

      const currentCoords = this.activeItem.coordinates || this.activeItem.ring || this.activeItem.positions || [];

      this.dragState = {
        isDragging: true,
        dragMode: handleType,
        itemId: itemId,
        targetItem: this.activeItem,
        vertexIndex: handleType === 'VERTEX' ? vertexIndex : null,
        lastCartographic: startPos,
        initialCoordinates: JSON.parse(JSON.stringify(currentCoords)),
        currentCoordinates: JSON.parse(JSON.stringify(currentCoords)),
      };
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // MOUSE_MOVE: Calculate coordinate deltas and update live geometry
    this.handler.setInputAction((movement) => {
      if (!this.dragState.isDragging || !movement?.endPosition || !this.dragState.lastCartographic) {
        return;
      }

      const currentCartographic = resolveCartographicPosition(this.viewer.scene, movement.endPosition);
      if (!currentCartographic) return;

      const deltaLng = Cesium.Math.toDegrees(currentCartographic.longitude - this.dragState.lastCartographic.longitude);
      const deltaLat = Cesium.Math.toDegrees(currentCartographic.latitude - this.dragState.lastCartographic.latitude);

      if (Math.abs(deltaLng) < 1e-8 && Math.abs(deltaLat) < 1e-8) return;

      let nextCoords = [];

      if (this.dragState.dragMode === 'CENTROID') {
        nextCoords = translateCoordinates(this.dragState.currentCoordinates, deltaLng, deltaLat);
      } else if (this.dragState.dragMode === 'VERTEX' && this.dragState.vertexIndex !== null) {
        const idx = this.dragState.vertexIndex;
        nextCoords = JSON.parse(JSON.stringify(this.dragState.currentCoordinates));
        if (nextCoords[idx]) {
          if (Array.isArray(nextCoords[idx])) {
            nextCoords[idx][0] = Number((Number(nextCoords[idx][0] || 0) + deltaLng).toFixed(7));
            nextCoords[idx][1] = Number((Number(nextCoords[idx][1] || 0) + deltaLat).toFixed(7));
          } else if (typeof nextCoords[idx] === 'object') {
            const lngKey = 'lng' in nextCoords[idx] ? 'lng' : ('lon' in nextCoords[idx] ? 'lon' : 'lng');
            nextCoords[idx][lngKey] = Number((Number(nextCoords[idx][lngKey] || 0) + deltaLng).toFixed(7));
            nextCoords[idx].lat = Number((Number(nextCoords[idx].lat || 0) + deltaLat).toFixed(7));
          }
        }
      }

      this.dragState.currentCoordinates = nextCoords;
      this.dragState.lastCartographic = currentCartographic;

      if (this.activeItem) {
        if (this.activeItem.coordinates) this.activeItem.coordinates = nextCoords;
        if (this.activeItem.ring) this.activeItem.ring = nextCoords;
        if (this.activeItem.positions) this.activeItem.positions = nextCoords;
      }

      this.renderHandles(this.activeItem);

      if (typeof this.options.onUpdate === 'function') {
        this.options.onUpdate(nextCoords, this.dragState.dragMode, this.activeItem);
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // LEFT_UP: Commit final geometry
    this.handler.setInputAction(() => {
      this.commitDrag();
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
  }

  /**
   * Destroys handlers and data sources.
   */
  destroy() {
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
    }
    if (this.dataSource && this.viewer?.dataSources) {
      try {
        this.viewer.dataSources.remove(this.dataSource, true);
      } catch {
        /* teardown */
      }
      this.dataSource = null;
    }
  }
}
