//! View object-value protocol. Static schemas pass through once; do not hydrate
//! them into every node (or consult the compile server on every value request).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::view::UnitySerializedPropertyTarget;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRead {
    pub target: UnitySerializedPropertyTarget,
    #[serde(default)] pub revision: Option<String>,
    pub max_depth: i32,
    pub max_array_items: i32,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub action: String,
    #[serde(default)] pub reads: Vec<ObjectRead>,
    #[serde(default)] pub write: Option<super::UnitySerializedPropertyWriteRequest>,
    #[serde(default)] pub known_schemas: Vec<String>,
}

fn payload(request: Request) -> Result<Value, String> {
    if request.known_schemas.len() > 8192 || request.known_schemas.iter().any(|id| id.len() > 128) {
        return Err("Property object schema budget exceeded".into());
    }
    match request.action.as_str() {
        "read" => {
            if request.reads.is_empty() || request.reads.len() > 32 || request.write.is_some() {
                return Err("Property object read requires 1 to 32 targets".into());
            }
            for read in &request.reads {
                super::validate_object_target(&read.target)?;
                if read.target.property_path.as_deref().is_some_and(|path| !path.is_empty()) {
                    return Err("Object reads require an object target".into());
                }
                if !(1..=16).contains(&read.max_depth) || !(1..=1024).contains(&read.max_array_items) {
                    return Err("Property object read budget out of range".into());
                }
            }
            Ok(json!({"action":"read", "reads":request.reads, "knownSchemas":request.known_schemas}))
        }
        "write" => {
            if !request.reads.is_empty() { return Err("Write cannot contain reads".into()); }
            let write = request.write.ok_or("Missing property object write")?;
            super::validate_property_target(&write.target)?;
            let mode = super::normalize_write_mode(write.write_mode.as_deref())?;
            Ok(json!({"action":"write", "knownSchemas":request.known_schemas,
                "write":{"bindingId":write.binding_id, "target":write.target,
                    "valueJson":serde_json::to_string(&write.value).map_err(|e|e.to_string())?, "mode":mode}}))
        }
        _ => Err("Unsupported property object action".into()),
    }
}

pub async fn execute(root: &str, request: Request) -> Result<Value, String> {
    let payload = payload(request)?;
    match crate::unity_bridge::property_objects(root, &payload).await {
        Ok(raw) => {
            let mut value: Value = serde_json::from_str(&raw).map_err(|e|format!("Invalid property object response: {e}"))?;
            if value["protocol"] != 1 { return Err("Unsupported property object protocol".into()); }
            exact_ids(&mut value);
            Ok(value)
        }
        // Only a read may discover an old bridge. Mutations never switch paths
        // after an error: even a reload interruption can follow a completed apply.
        Err(error) if payload["action"] == "read" && error.trim().eq_ignore_ascii_case("unknown message type: property_objects") =>
            Ok(json!({"protocol":1,"unsupported":true})),
        Err(error) => Err(error),
    }
}

fn exact_ids(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(exact_ids),
        Value::Object(fields) => for (key, value) in fields {
            if matches!(key.as_str(), "objectFileId" | "targetFileId" | "managedReferenceId") && value.is_number() {
                *value = Value::String(value.to_string());
            } else { exact_ids(value); }
        },
        _ => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read() -> Value { json!({"action":"read","reads":[{"target":{"kind":"asset","path":"Assets/A.asset","targetFileId":"9223372036854775806"},"maxDepth":6,"maxArrayItems":8}]}) }
    #[test] fn bounded_reads_keep_exact_identity() {
        let value = payload(serde_json::from_value(read()).unwrap()).unwrap();
        assert_eq!(value["reads"][0]["target"]["targetFileId"], "9223372036854775806");
    }
    #[test] fn rejects_invalid_scope_and_budgets() {
        for (key,value) in [("maxDepth",json!(17)),("maxArrayItems",json!(0))] {
            let mut request=read();request["reads"][0][key]=value;
            assert!(payload(serde_json::from_value(request).unwrap()).is_err());
        }
        let mut request=read();request["reads"][0]["target"]["propertyPath"]=json!("field");
        assert!(payload(serde_json::from_value(request).unwrap()).is_err());
        let mut request=read();request["reads"]=json!([]);
        assert!(payload(serde_json::from_value(request).unwrap()).is_err());
    }
    #[test] fn writes_use_existing_value_and_mode_validation() {
        let request=json!({"action":"write","write":{"target":{"kind":"asset","path":"Assets/A.asset","propertyPath":"amount"},"value":7}});
        let value=payload(serde_json::from_value(request).unwrap()).unwrap();
        assert_eq!(value["write"]["valueJson"],"7");assert_eq!(value["write"]["mode"],"commit");
    }
}
