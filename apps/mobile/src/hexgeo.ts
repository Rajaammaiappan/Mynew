/** H3 → GeoJSON helpers for the MapLibre hex overlay. */
import { cellToBoundary, cellToParent, gridDisk, latLngToCell } from 'h3-js';

export interface OwnedHex {
  h3: string;
  color: string;
  strength: number;
  mine: boolean;
}

export function hexFeatureCollection(hexes: OwnedHex[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: hexes.map((h) => ({
      type: 'Feature',
      properties: {
        color: h.color,
        opacity: Math.max(0.12, 0.45 * (h.strength / 100)),
        mine: h.mine ? 1 : 0,
      },
      geometry: {
        type: 'Polygon',
        // GeoJSON wants [lng,lat] closed rings; h3 gives [lat,lng]
        coordinates: [[...cellToBoundary(h.h3), cellToBoundary(h.h3)[0]].map(([lat, lng]) => [lng, lat])],
      },
    })),
  };
}

/** res-5 cells covering a point's neighborhood — what we subscribe/query with. */
export function viewportCells(lat: number, lng: number): string[] {
  return gridDisk(cellToParent(latLngToCell(lat, lng, 9), 5), 1).slice(0, 6);
}
