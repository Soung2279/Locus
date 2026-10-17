
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import {
  createUnityObjectDrawerLibrary,
  defineUnityObjectDrawers,
  hasEditableUnityPropertySnapshot,
  isUnityCodeSourceAssetPath,
  isUnityExternalSourceAssetPath,
  isUnityLiveSerializedAssetPath,
  normalizeUnityObjectPreviewModel,
  resolveUnityObjectDrawer,
  type UnityObjectDrawerContext,
  unityObjectPreviewAssetRef,
  type UnityObjectPreviewInput,
} from "../components/unity-preview";

describe("unityObjectPreview", () => {
  it("keeps external model source assets previewable and read-only", () => {
    const model = normalizeUnityObjectPreviewModel({
      kind: "asset",
      path: "Assets/Characters/Hero.fbx",
      name: "Hero",
    });

    expect(model.title).toBe("Hero");
    expect(model.iconKind).toBe("model");
    expect(model.capabilities.preview).toBe(true);
    expect(model.capabilities.edit).toBe(false);
    expect(model.editState).toBe("externalSource");
    expect(model.readonlyReason).toBe("External source asset");
    expect(isUnityExternalSourceAssetPath(model.ref.path)).toBe(true);
  });

  it("classifies script and shader sources as code source assets", () => {
    expect(isUnityCodeSourceAssetPath("Assets/Scripts/Effects/FireLight.cs")).toBe(true);
    expect(isUnityCodeSourceAssetPath("Assets/Shaders/Water.shader")).toBe(true);
    expect(isUnityCodeSourceAssetPath("Assets/Shaders/Blur.compute")).toBe(true);
    expect(isUnityCodeSourceAssetPath("Assets/Shaders/Common.cginc")).toBe(true);
    expect(isUnityCodeSourceAssetPath("Assets/Prefabs/Enemy.prefab")).toBe(false);
    expect(isUnityCodeSourceAssetPath("Assets/Data/Notes.txt")).toBe(false);
  });

  it("routes only Unity-native serialized assets to the live property tree", () => {
    // Unity-native serialized assets keep the live editor round-trip.
    expect(isUnityLiveSerializedAssetPath("Assets/Prefabs/Enemy.prefab")).toBe(true);
    expect(isUnityLiveSerializedAssetPath("Assets/Scenes/Main.unity")).toBe(true);
    expect(isUnityLiveSerializedAssetPath("Assets/Materials/Water.mat")).toBe(true);
    expect(isUnityLiveSerializedAssetPath("Assets/Data/BasicAttack.asset")).toBe(true);
    expect(isUnityLiveSerializedAssetPath("Assets/UI/Icons.spriteatlas")).toBe(true);
    expect(isUnityLiveSerializedAssetPath("Assets/Audio/Master.mixer")).toBe(true);
    // Extension-less refs (folders) resolve to DefaultAsset and stay live.
    expect(isUnityLiveSerializedAssetPath("Assets/AIGen")).toBe(true);
    // Text, source, and binary files preview from disk instead (#114): the
    // live path breaks whenever Unity has not imported the file, e.g. under
    // symlinked folders.
    expect(isUnityLiveSerializedAssetPath("Assets/AIGen/回复流程.md")).toBe(false);
    expect(isUnityLiveSerializedAssetPath("Assets/Data/Notes.txt")).toBe(false);
    expect(isUnityLiveSerializedAssetPath("Assets/Config/settings.json")).toBe(false);
    expect(isUnityLiveSerializedAssetPath("Assets/Scripts/FireLight.cs")).toBe(false);
    expect(isUnityLiveSerializedAssetPath("Assets/Characters/Hero.fbx")).toBe(false);
    expect(isUnityLiveSerializedAssetPath("Assets/Textures/Grass.png")).toBe(false);
    expect(isUnityLiveSerializedAssetPath("Assets/Tools/report.html")).toBe(false);
  });

  it("uses asset file names with extensions for default titles", () => {
    const scriptModel = normalizeUnityObjectPreviewModel({
      kind: "asset",
      path: "Assets/Scripts/AttackConfigSO.cs",
    });
    const configModel = normalizeUnityObjectPreviewModel({
      kind: "asset",
      path: "Assets/Data/BasicAttack.asset",
    });

    expect(scriptModel.title).toBe("AttackConfigSO.cs");
    expect(configModel.title).toBe("BasicAttack.asset");
  });

  it("allows importer property trees to opt into editing", () => {
    const input: UnityObjectPreviewInput = {
      ref: {
        kind: "importer",
        path: "Assets/Characters/Hero.fbx",
        name: "Hero Importer",
      },
      propertyTree: {
        propertyPath: "importer",
        displayName: "Importer",
        valueType: "Generic",
        value: null,
        editable: false,
        children: [
          {
            propertyPath: "importer.importMaterials",
            displayName: "Import Materials",
            valueType: "Boolean",
            value: true,
            editable: true,
          },
        ],
      },
    };

    const model = normalizeUnityObjectPreviewModel(input);

    expect(model.ref.kind).toBe("importer");
    expect(model.capabilities.drag).toBe(false);
    expect(model.capabilities.edit).toBe(true);
    expect(model.editState).toBe("editable");
    expect(model.readonlyReason).toBeUndefined();
  });

  it("detects editable descendants without requiring the root to be editable", () => {
    expect(hasEditableUnityPropertySnapshot({
      propertyPath: "root",
      valueType: "Generic",
      value: null,
      editable: false,
      children: [
        {
          propertyPath: "root.name",
          valueType: "String",
          value: "Player",
          editable: true,
        },
      ],
    })).toBe(true);

    expect(hasEditableUnityPropertySnapshot({
      propertyPath: "root",
      valueType: "Generic",
      value: null,
      editable: false,
      children: [
        {
          propertyPath: "root.name",
          valueType: "String",
          value: "Player",
          editable: false,
        },
      ],
    })).toBe(false);
  });

  it("normalizes scene object refs and exposes Unity drag refs", () => {
    const model = normalizeUnityObjectPreviewModel({
      kind: "sceneObject",
      path: "Assets/Scenes/Main.unity/Root/Player",
      name: "Player",
    });

    expect(model.ref.kind).toBe("sceneObject");
    expect(model.iconKind).toBe("gameobject");
    expect(model.capabilities.select).toBe(true);
    expect(model.capabilities.drag).toBe(true);
    expect(unityObjectPreviewAssetRef(model)).toEqual({
      kind: "sceneObject",
      path: "Assets/Scenes/Main.unity/Root/Player",
      name: "Player",
      typeLabel: undefined,
      source: "manual",
    });
  });

  it("keeps guid-only refs selectable without requiring editable property data", () => {
    const model = normalizeUnityObjectPreviewModel({
      kind: "asset",
      guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(model.ref.path).toBe("");
    expect(model.ref.guid).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(model.title).toBe("aaaaaaaa");
    expect(model.subtitle).toBe("GUID");
    expect(model.capabilities.select).toBe(true);
    expect(model.capabilities.drag).toBe(false);
    expect(model.capabilities.edit).toBe(false);
    expect(model.propertyTree).toBeNull();
  });

  it("keeps package assets read-only unless the caller provides mutability", () => {
    const readonlyModel = normalizeUnityObjectPreviewModel({
      kind: "asset",
      path: "Packages/com.vendor.tool/Runtime/Config.asset",
      propertyTree: {
        propertyPath: "config.enabled",
        valueType: "Boolean",
        value: true,
        editable: true,
      },
    });
    const writableModel = normalizeUnityObjectPreviewModel({
      kind: "asset",
      path: "Packages/com.vendor.tool/Runtime/Config.asset",
      writable: true,
      propertyTree: readonlyModel.propertyTree,
    });

    expect(readonlyModel.capabilities.edit).toBe(false);
    expect(readonlyModel.readonlyReason).toBe("Package asset");
    expect(writableModel.capabilities.edit).toBe(true);
  });

  it("resolves Unity object drawers by combined object and level matchers", () => {
    const PrefabThumbnailDrawer = defineComponent({ name: "PrefabThumbnailDrawer" });
    const RowDrawer = defineComponent({ name: "RowDrawer" });
    const model = normalizeUnityObjectPreviewModel({
      kind: "asset",
      path: "Assets/Prefabs/Enemy.prefab",
    });
    const baseContext: UnityObjectDrawerContext = {
      level: "thumbnail",
      selected: false,
      disabled: false,
      readonly: false,
      draggable: true,
      loading: false,
      error: "",
    };
    const library = createUnityObjectDrawerLibrary(defineUnityObjectDrawers([
      {
        extension: ".prefab",
        level: "thumbnail",
        drawer: PrefabThumbnailDrawer,
      },
      {
        level: "row",
        drawer: RowDrawer,
      },
    ]));

    expect(resolveUnityObjectDrawer(model, baseContext, library)).toBe(PrefabThumbnailDrawer);
    expect(resolveUnityObjectDrawer(model, { ...baseContext, level: "row" }, library)).toBe(RowDrawer);
    expect(resolveUnityObjectDrawer(model, { ...baseContext, level: "inspector" }, library)).toBeNull();
  });
});
