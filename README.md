# GeoFS NPC Traffic

NPC planes for GeoFS. Arrivals fly a final approach, land, exit the runway, taxi to a gate and park. Parked planes then push back, taxi to the runway, hold short until it is clear, and take off. Runways, taxiways and gates are scanned automatically from OpenStreetMap, so nothing has to be marked by hand. List of current airports:

Incheon (RKSI / ICN)

There is no on-screen UI. Fly within 30 km of the airport and traffic is already there: planes parked at gates, planes taxiing, and planes on final approach. Arrivals land, taxi to a free gate and park.

<img src="https://raw.githubusercontent.com/747400forlife/geofs-npc-traffi/refs/heads/main/Screenshot%202026-11-12%20021629.png" width="100%"/><br />

## How To Install

1. Go to `geofs-npc-traffic.user.js`, and copy the code.
2. Install the script in Tampermonkey (open the raw file URL, or paste it into a new script).
3. Or right-click anywhere in GeoFS and click "Inspect". Paste the code from `geofs-npc-traffic.user.js` in the consle, and hit ENTER.

All models deserve credit to the owners, so credit the authors here:

- Korean Air A380 by zairiqzairiq (https://sketchfab.com/3d-models/korean-air-a380-33fa332e130c4138a1011bd7b1de97e2), CC BY 4.0
- Boeing 777 by 1883 (https://sketchfab.com/3d-models/boeing-777-df830e5199634ae2955bf5b618ba6ab3), CC BY 4.0
- Korean Air 747 by zairiq-zairiq-123-pixar-cars-bfdi (https://sketchfab.com/3d-models/korean-air-747-665ce49f8f1f46638767d6529926abb8), CC BY 4.0
- Jeju Air 737 MAX 8: by Sofyan Kurniawan & Glazed_Kimpab (livery) (https://sketchfab.com/3d-models/737-max-lion-air-2747cad8b4c64122abe992c9ad1e8bd1)
- UPS McDonnell Douglas MD-11F by ahmdmhdymhmdshwat5 (https://sketchfab.com/3d-models/ups-mcdonnell-douglas-md-11f-b812206bbdd4429a9b34a18b7a5aff12), CC BY 4.0
- Air India Boeing 787 by Tfs product (https://sketchfab.com/3d-models/air-india-boeing-787-free-if-68c5999a9e3346cd960633475238d4da), CC BY 4.0
- Delta A350-900 by Alexrhee18 (https://sketchfab.com/3d-models/delta-a350-900-with-lights-6209d852227c46139143b31c9a31a062), CC BY 4.0
- Airbus A350-900 (Finnair, Lufthansa) by GeoFS (Xavier Tassin)

Both were resized to real-world metres, re-centred near the main gear and turned so the nose points down +Z, with the wheels at ground level, so one `headingOffset` value should fit every model prepared this way.

## Notes

More is to come, and the addon is currently still in early stage. Please notify me if you have any suggestions, or any airports you want! More to come soon...
