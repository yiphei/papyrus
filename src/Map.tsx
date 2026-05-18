import Map from 'react-map-gl/mapbox'

export default function MapView() {
  return (
    <Map
      mapboxAccessToken={import.meta.env.VITE_MAPBOX_TOKEN}
      initialViewState={{ longitude: -122.4194, latitude: 37.7749, zoom: 12 }}
      style={{ width: '100vw', height: '100vh' }}
      mapStyle="mapbox://styles/mapbox/streets-v12"
    />
  )
}
