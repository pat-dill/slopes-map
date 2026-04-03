level_12 = """
[out:json][timeout:25];

(
  way
  ["highway"]
  ["highway"="trunk"]
  ({{bbox}});
  
  way
  ["highway"]
  ["highway"="secondary"]
  ({{bbox}});
  
  way
  ["highway"]
  ["highway"="tertiary"]
  ({{bbox}});
  
  way
  ["highway"]
  ["highway"="cycleway"]
  ({{bbox}});
);

out geom;
"""

level_13 = """
[out:json][timeout:60];

(
  way
  ["highway"]
  ["highway"!="motorway"]
  ["highway"!="motorway_link"]
  ["highway"!="track"]
  ["highway"!="service"]
  ["expressway"!="yes"]
  ["indoor"!="yes"]
  ["footway"!="sidewalk"]
  ["access"!="no"]
  ["access"!="private"]
  ["footway"!="crossing"]
  ["area"!="yes"]
  ["bridge"!="yes"]
  ["tunnel"!="yes"]
  ({{bbox}});
);

out geom;
"""


queries = {
    12: level_12,
    13: level_13,
}
