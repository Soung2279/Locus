use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub const MAX_PIXELS: usize = 16_777_216;

/// Camera/view facts captured with the image, even if ID/depth readback fails.
/// Kept in the compact summary; this does not imply that spatial queries exist.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureViewContext {
    pub target: String,
    pub scene: String,
    pub projection: String,
    pub has_camera: bool,
    pub camera_position: [f32; 3],
    pub camera_forward: [f32; 3],
    pub spatial_error: Option<String>,
}
impl CaptureViewContext {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.target.as_str(), "scene" | "game")
            || self.scene.len() > 16384
            || !matches!(
                self.projection.as_str(),
                "perspective" | "orthographic" | "unavailable"
            )
            || !self
                .camera_position
                .iter()
                .chain(&self.camera_forward)
                .all(|v| v.is_finite())
        {
            return Err("Invalid screenshot view context".into());
        }
        Ok(())
    }
    pub fn summary(&self, id: &str) -> String {
        let camera = if self.has_camera {
            format!(
                "camera={} forward={}",
                json!(self.camera_position.map(|n| rounded(n as f64))),
                json!(self.camera_forward.map(|n| rounded(n as f64)))
            )
        } else {
            "camera=unavailable".into()
        };
        format!(
            "capture={id} scene={} view={} projection={}\n{camera}\nspatial=unavailable reason={}",
            json!(self.scene.chars().take(256).collect::<String>()),
            self.target,
            self.projection,
            json!(self
                .spatial_error
                .as_deref()
                .unwrap_or("Object/depth data unavailable")
                .chars()
                .take(120)
                .collect::<String>())
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialObject {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub global_object_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialSnapshot {
    pub version: u32,
    pub target: String,
    pub scene: String,
    pub width: u32,
    pub height: u32,
    pub projection: String,
    pub camera_position: [f32; 3],
    pub camera_forward: [f32; 3],
    pub inverse_view_projection: [f32; 16],
    pub view_matrix: [f32; 16],
    pub screen_rect: [i32; 4],
    /// Screenshot rectangle in the original view, normalized, top-left origin.
    #[serde(default = "full_rect")]
    pub uv_rect: [f64; 4],
    pub objects: Vec<SpatialObject>,
    pub quality: String,
    /// Full-resolution picking rows are bottom-up. No per-pixel XYZ is stored.
    #[serde(skip)]
    pub ids: Vec<u32>,
    #[serde(skip)]
    pub depths: Vec<f32>,
}
fn full_rect() -> [f64; 4] {
    [0., 0., 1., 1.]
}
fn multiply(m: &[f32; 16], v: [f64; 4]) -> [f64; 4] {
    std::array::from_fn(|r| (0..4).map(|c| m[r * 4 + c] as f64 * v[c]).sum())
}
fn short(s: &str) -> String {
    s.chars().take(80).collect()
}
fn rounded(v: f64) -> f64 {
    (v * 10000.).round() / 10000.
}

impl SpatialSnapshot {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.target.as_str(), "game" | "scene")
            || !matches!(self.projection.as_str(), "perspective" | "orthographic")
            || self.quality != "editor-picking-geometry"
            || self.scene.len() > 16384
        {
            return Err("Unsupported spatial snapshot semantics".into());
        }
        let count = self.width as usize * self.height as usize;
        if self.version != 1
            || count == 0
            || count > MAX_PIXELS
            || self.ids.len() != count
            || self.depths.len() != count
        {
            return Err("Invalid spatial snapshot dimensions or version".into());
        }
        if self.objects.len() > 100_000
            || self.objects.iter().any(|o| {
                o.name.len() > 4096 || o.path.len() > 16384 || o.global_object_id.len() > 512
            })
        {
            return Err("Spatial object table exceeds capture limits".into());
        }
        let unique: HashSet<_> = self.objects.iter().map(|o| o.id).collect();
        if unique.len() != self.objects.len() || unique.contains(&0) {
            return Err("Invalid spatial object IDs".into());
        }
        if !self
            .inverse_view_projection
            .iter()
            .chain(&self.view_matrix)
            .chain(&self.camera_position)
            .chain(&self.camera_forward)
            .all(|v| v.is_finite())
        {
            return Err("Invalid camera matrix".into());
        }
        validate_rect(self.uv_rect)?;
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let mut bytes = Vec::with_capacity(self.ids.len() * 8);
        #[cfg(target_endian = "little")]
        // u32/f32 are padding-free, four-byte primitives. Borrow their initialized
        // bytes in two bulk copies instead of millions of Vec::extend calls.
        unsafe {
            bytes.extend_from_slice(std::slice::from_raw_parts(
                self.ids.as_ptr().cast::<u8>(),
                self.ids.len() * 4,
            ));
            bytes.extend_from_slice(std::slice::from_raw_parts(
                self.depths.as_ptr().cast::<u8>(),
                self.depths.len() * 4,
            ));
        }
        #[cfg(target_endian = "big")]
        {
            for id in &self.ids {
                bytes.extend(id.to_le_bytes());
            }
            for depth in &self.depths {
                bytes.extend(depth.to_le_bytes());
            }
        }
        zstd::stream::encode_all(bytes.as_slice(), 3).map_err(|e| e.to_string())
    }

    pub fn decode(mut self, bytes: &[u8]) -> Result<Self, String> {
        use std::io::Read;
        let count = self.width as usize * self.height as usize;
        if count == 0 || count > MAX_PIXELS {
            return Err("Invalid spatial dimensions".into());
        }
        let decoder = zstd::stream::read::Decoder::new(bytes).map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        decoder
            .take((count * 8 + 1) as u64)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        if raw.len() != count * 8 {
            return Err("Corrupt spatial payload".into());
        }
        self.load_planes(&raw)?;
        self.validate()?;
        Ok(self)
    }

    pub fn load_planes(&mut self, raw: &[u8]) -> Result<(), String> {
        let count = self.width as usize * self.height as usize;
        if count == 0 || count > MAX_PIXELS || raw.len() != count * 8 {
            return Err("Invalid spatial plane size".into());
        }
        #[cfg(target_endian = "little")]
        {
            self.ids = vec![0; count];
            self.depths = vec![0.; count];
            // Copy bytes into fully allocated, aligned primitive arrays. Every
            // bit pattern is valid for u32 and f32; reads are bounded above.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    raw.as_ptr(),
                    self.ids.as_mut_ptr().cast::<u8>(),
                    count * 4,
                );
                std::ptr::copy_nonoverlapping(
                    raw.as_ptr().add(count * 4),
                    self.depths.as_mut_ptr().cast::<u8>(),
                    count * 4,
                );
            }
        }
        #[cfg(target_endian = "big")]
        {
            self.ids = raw[..count * 4]
                .chunks_exact(4)
                .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            self.depths = raw[count * 4..]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
        }
        Ok(())
    }

    fn pixel(&self, uv: [f64; 2]) -> Result<(usize, u32, u32), String> {
        if !uv.iter().all(|v| v.is_finite() && (0. ..=1.).contains(v)) {
            return Err("uv must be normalized image coordinates [0, 1]".into());
        }
        let u = self.uv_rect[0] + uv[0] * (self.uv_rect[2] - self.uv_rect[0]);
        let v = self.uv_rect[1] + uv[1] * (self.uv_rect[3] - self.uv_rect[1]);
        let x = ((u * self.width as f64).floor() as u32).min(self.width - 1);
        let y = self.height - 1 - ((v * self.height as f64).floor() as u32).min(self.height - 1);
        Ok(((y * self.width + x) as usize, x, y))
    }

    pub fn pick(&self, uv: [f64; 2], fields: &[String]) -> Result<Value, String> {
        validate_fields(fields, &["object", "world", "depth"])?;
        let (index, x, y) = self.pixel(uv)?;
        let Some(object) = self.objects.iter().find(|o| o.id == self.ids[index]) else {
            return Ok(json!({"hit":false}));
        };
        let depth = self.depths[index] as f64;
        if !depth.is_finite() || !(0. ..=1.).contains(&depth) {
            return Ok(json!({"hit":false}));
        }
        let h = multiply(
            &self.inverse_view_projection,
            [
                (x as f64 + 0.5) / self.width as f64 * 2. - 1.,
                (y as f64 + 0.5) / self.height as f64 * 2. - 1.,
                depth,
                1.,
            ],
        );
        if !h.iter().all(|n| n.is_finite()) || h[3].abs() < 1e-12 {
            return Ok(json!({"hit":false}));
        }
        let world = [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
        let mut result = serde_json::Map::new();
        if fields.iter().any(|f| f == "object") {
            result.insert(
                "object".into(),
                json!({"ref":format!("o{}", object.id),"name":short(&object.name)}),
            );
        }
        if fields.iter().any(|f| f == "world") {
            result.insert("world".into(), json!(world.map(rounded)));
        }
        if fields.iter().any(|f| f == "depth") {
            result.insert(
                "depth".into(),
                json!(rounded(
                    -multiply(&self.view_matrix, [world[0], world[1], world[2], 1.])[2]
                )),
            );
        }
        Ok(Value::Object(result))
    }

    pub fn objects_in(
        &self,
        rect: [f64; 4],
        fields: &[String],
        offset: usize,
        limit: usize,
    ) -> Result<Value, String> {
        validate_rect(rect)?;
        validate_fields(fields, &["ref", "name", "path", "bounds"])?;
        if limit == 0 || limit > 32 || offset > self.objects.len() {
            return Err("limit must be 1–32 and offset must be within the object table".into());
        }
        let (_, x0, y1) = self.pixel([rect[0], rect[1]])?;
        let (_, x1, y0) = self.pixel([rect[2], rect[3]])?;
        let mut visible = BTreeMap::<u32, (usize, u32, u32, u32, u32)>::new();
        for y in y0..=y1 {
            for x in x0..=x1 {
                let id = self.ids[(y * self.width + x) as usize];
                if id == 0 {
                    continue;
                }
                let entry = visible.entry(id).or_insert((0, x, y, x, y));
                entry.0 += 1;
                entry.1 = entry.1.min(x);
                entry.2 = entry.2.min(y);
                entry.3 = entry.3.max(x);
                entry.4 = entry.4.max(y);
            }
        }
        let mut ranked: Vec<_> = self
            .objects
            .iter()
            .filter_map(|o| visible.get(&o.id).map(|bounds| (o, *bounds)))
            .collect();
        ranked.sort_by_key(|(o, b)| (std::cmp::Reverse(b.0), o.id));
        let total = ranked.len();
        let items: Vec<_> = ranked
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(o, b)| {
                let mut item = serde_json::Map::new();
                for field in fields {
                    match field.as_str() {
                        "ref" => {
                            item.insert(field.clone(), json!(format!("o{}", o.id)));
                        }
                        "name" => {
                            item.insert(field.clone(), json!(short(&o.name)));
                        }
                        "path" => {
                            item.insert(
                                field.clone(),
                                json!(o.path.chars().take(240).collect::<String>()),
                            );
                        }
                        "bounds" => {
                            let map_x = |x: f64| {
                                (x / self.width as f64 - self.uv_rect[0])
                                    / (self.uv_rect[2] - self.uv_rect[0])
                            };
                            let map_y = |y: f64| {
                                (y / self.height as f64 - self.uv_rect[1])
                                    / (self.uv_rect[3] - self.uv_rect[1])
                            };
                            item.insert(
                                field.clone(),
                                json!([
                                    map_x(b.1 as f64),
                                    map_y((self.height - 1 - b.4) as f64),
                                    map_x((b.3 + 1) as f64),
                                    map_y((self.height - b.2) as f64)
                                ]
                                .map(|n| rounded(n.clamp(0., 1.)))),
                            );
                        }
                        _ => {}
                    }
                }
                Value::Object(item)
            })
            .collect();
        let end = offset + items.len();
        Ok(json!({"items":items,"next_offset":if end<total{Some(end)}else{None}}))
    }

    pub fn summary(&self, id: &str) -> String {
        let anchor = self
            .pick([0.5, 0.5], &["object".into(), "world".into()])
            .unwrap_or(json!({"hit":false}));
        format!("capture={id} scene={} view={} projection={}\ncamera={} forward={}\nanchor_uv=[0.5,0.5] anchor={} quality={}",
            json!(self.scene.chars().take(256).collect::<String>()),self.target,self.projection,
            json!(self.camera_position.map(|n|rounded(n as f64))),json!(self.camera_forward.map(|n|rounded(n as f64))),anchor,self.quality)
    }
}
pub fn validate_rect(r: [f64; 4]) -> Result<(), String> {
    if !r.iter().all(|v| v.is_finite() && (0. ..=1.).contains(v)) || r[0] >= r[2] || r[1] >= r[3] {
        Err("rect must be [left, top, right, bottom] within [0,1]".into())
    } else {
        Ok(())
    }
}
pub fn validate_fields(fields: &[String], allowed: &[&str]) -> Result<(), String> {
    if fields.is_empty()
        || fields.len() > allowed.len()
        || fields.iter().any(|f| !allowed.contains(&f.as_str()))
    {
        Err("Unsupported capture fields".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn fixture() -> SpatialSnapshot {
        let identity = [
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ];
        SpatialSnapshot {
            version: 1,
            target: "scene".into(),
            scene: "Assets/Test.unity".into(),
            width: 4,
            height: 4,
            projection: "orthographic".into(),
            camera_position: [0.; 3],
            camera_forward: [0., 0., 1.],
            inverse_view_projection: identity,
            view_matrix: identity,
            screen_rect: [0, 0, 400, 400],
            uv_rect: full_rect(),
            objects: vec![SpatialObject {
                id: 1,
                name: "Cube".into(),
                path: "Root/Cube".into(),
                global_object_id: "gid".into(),
            }],
            quality: "editor-picking-geometry".into(),
            ids: vec![1; 16],
            depths: vec![0.5; 16],
        }
    }
    #[test]
    fn spatial_point_uses_image_origin_and_selected_fields() {
        let mut s = fixture();
        assert_eq!(
            s.pick([0.125, 0.125], &["world".into()]).unwrap(),
            json!({"world":[-0.75,0.75,0.5]})
        );
        s.uv_rect = [0.25, 0.25, 0.75, 0.75];
        assert_eq!(
            s.pick([0., 0.], &["world".into()]).unwrap(),
            json!({"world":[-0.25,0.25,0.5]})
        );
        s.ids[9] = 0;
        assert_eq!(
            s.pick([0., 0.], &["object".into()]).unwrap(),
            json!({"hit":false})
        );
        assert!(s.pick([f64::NAN, 0.], &["world".into()]).is_err());
        assert!(s.pick([0., 0.], &["matrix".into()]).is_err());
    }
    #[test]
    fn spatial_codec_preserves_foreground_bits_and_rejects_truncation() {
        let mut s = fixture();
        s.depths[3] = f32::from_bits(0x3e12_3456);
        let bytes = s.encode().unwrap();
        let out = s.clone().decode(&bytes).unwrap();
        assert_eq!(out.depths[3].to_bits(), s.depths[3].to_bits());
        assert_eq!(out.ids, s.ids);
        assert!(s.decode(&bytes[..bytes.len() / 2]).is_err());
    }
    #[test]
    fn spatial_region_is_bounded_and_does_not_expand_unrequested_data() {
        let s = fixture();
        let page = s.objects_in(full_rect(), &["ref".into()], 0, 8).unwrap();
        assert_eq!(page, json!({"items":[{"ref":"o1"}],"next_offset":null}));
        assert!(s.objects_in(full_rect(), &["name".into()], 0, 33).is_err());
        assert!(s.summary("c42").len() < 650);
        assert!(!s.summary("c42").contains("inverseViewProjection"));
    }
}
