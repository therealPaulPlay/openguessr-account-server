export function calculateMapBounds(locationsArray) {
    // If the location array is new, calculate new map zoom and center coords
    let south = Infinity;
    let north = -Infinity;
    let west = Infinity;
    let east = -Infinity;

    locationsArray.forEach(([lat, lon]) => {
        lat = parseFloat(lat);
        lon = parseFloat(lon);

        if (lat > north) north = lat;
        if (lat < south) south = lat;
        if (lon > east) east = lon;
        if (lon < west) west = lon;
    });

    // Calculate the center point
    let centerLat = (north + south) / 2;
    const centerLon = (east + west) / 2;

    // Calculate the longer side
    const latDiff = north - south;
    const lonDiff = east - west;

    // Calculate zoom level
    const zoomLevel = calculateZoom(Math.max(latDiff, lonDiff));
    if (zoomLevel <= 2) centerLat = centerLat + 10;

    return { zoom: zoomLevel, lat: centerLat, lng: centerLon, diameter: Math.max(latDiff, lonDiff) } // Diameter is not in km / m, but coords
}

function calculateZoom(diameter) {
    if (diameter > 60) return 2;       // entire planet view
    if (diameter > 20) return 3;       // large country
    if (diameter > 10) return 4;       // medium country
    if (diameter > 5) return 5;        // small country
    return Math.min(10, 6 + Math.floor(5 - diameter)); // smaller region, minimum zoom at 10
}