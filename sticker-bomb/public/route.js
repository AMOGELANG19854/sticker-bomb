globalThis.route = [
  {name:'La Perla', lat:-33.918679, lng:18.385657, walk:0},
  {name:'Promenade north of Church Road', lat:-33.918269, lng:18.385908, walk:48},
  {name:'Promenade north path', lat:-33.917942, lng:18.386457, walk:136},
  {name:'Promenade bend', lat:-33.917576, lng:18.386828, walk:201},
  {name:'Promenade north walkway', lat:-33.917158, lng:18.387330, walk:395},
  {name:'Promenade north turnaround', lat:-33.916782, lng:18.387622, walk:380},
  {name:'Beach Road south of Church Road', lat:-33.919038, lng:18.385498, walk:101},
  {name:'Beach Road south path', lat:-33.919451, lng:18.385071, walk:141},
  {name:'Promenade south walkway', lat:-33.919793, lng:18.384693, walk:214},
  {name:'Promenade south bend', lat:-33.920249, lng:18.384403, walk:278},
  {name:'Promenade south turnaround', lat:-33.920539, lng:18.383920, walk:334}
];

const campaignAreas = {'sea-point':{label:'Sea Point, Cape Town',center:globalThis.route[0]}};
const jobRadius = 50000;
function placementDistance(point, start) {
  const {lat,lng} = point ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) return Infinity;
  const radians = Math.PI/180;
  const a = Math.sin((lat-start.lat)*radians/2)**2
    + Math.cos(lat*radians)*Math.cos(start.lat*radians)*Math.sin((lng-start.lng)*radians/2)**2;
  return 12742000*Math.asin(Math.sqrt(Math.min(1,a)));
}
function campaignRoute(job) {
  return job.area === 'local-test'
    ? [{name:'Local test spot',lat:job.test_lat,lng:job.test_lng}]
    : globalThis.route;
}
function areaLabel(job) {
  return job.area === 'local-test' ? 'Local test spot' : campaignAreas['sea-point'].label;
}
function withinJobRadius(point, job) {
  return placementDistance(point,campaignRoute(job)[0]) <= jobRadius;
}
