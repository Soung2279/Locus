using System;
using System.Collections.Generic;
using Locus.Rendering;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

// This is View business code, compiled through the existing View script API.
// Scene setup, pipeline choice, camera controls and animation are not in the SDK.
public static class RendererExample
{
    [Serializable] public sealed class Request { public string outputId; public bool playing; public float time; }
    static readonly Dictionary<string, Preview> Sessions = new Dictionary<string, Preview>();
    public static void Open(string json)
    {
        var request = JsonUtility.FromJson<Request>(json);
        if (Sessions.ContainsKey(request.outputId)) throw new InvalidOperationException("Output already initialized");
        var preview = new Preview(RenderOutput.Get(request.outputId));
        Sessions.Add(request.outputId, preview);
    }
    public static void SetPlaying(string json) { var r=JsonUtility.FromJson<Request>(json); Sessions[r.outputId].Playing=r.playing; }
    public static void Seek(string json) { var r=JsonUtility.FromJson<Request>(json); Sessions[r.outputId].Time=r.time; Sessions[r.outputId].Render(); }
    public static string Stats(string json) { var r=JsonUtility.FromJson<Request>(json); var p=Sessions[r.outputId]; return JsonUtility.ToJson(new Counters { inputs=p.Inputs, frames=(long)p.Output.PublishedFrames }); }
    [Serializable] public sealed class Counters { public int inputs; public long frames; }

    sealed class Preview
    {
        public readonly RenderOutput Output;
        public bool Playing=true;
        public float Time;
        public int Inputs;
        readonly Scene scene;
        readonly Camera camera;
        readonly Transform model;
        readonly Material material;
        RenderTexture target;
        float yaw=25, pitch=15, distance=4;
        double lastUpdate, nextFrame;
        bool closed;

        public Preview(RenderOutput output)
        {
            Output=output;
            scene=EditorSceneManager.NewPreviewScene();
            try {
                var go=new GameObject("View camera",typeof(Camera)); SceneManager.MoveGameObjectToScene(go,scene);
                camera=go.GetComponent<Camera>(); camera.enabled=false; camera.scene=scene;
                camera.fieldOfView=35; camera.clearFlags=CameraClearFlags.SolidColor; camera.backgroundColor=new Color(.12f,.13f,.15f,1);
                var cube=GameObject.CreatePrimitive(PrimitiveType.Cube); SceneManager.MoveGameObjectToScene(cube,scene); model=cube.transform;
                // Shader/pipeline policy belongs to this example, never RenderOutput.
                var shader=Shader.Find(GraphicsSettings.currentRenderPipeline==null?"Unlit/Color":"Universal Render Pipeline/Unlit");
                if(shader==null)throw new NotSupportedException("Choose a material for the project's render pipeline in RendererExample.cs.");
                material=new Material(shader); material.color=new Color(.25f,.65f,.8f,1); cube.GetComponent<Renderer>().sharedMaterial=material;
                Resize(output.RequestedSize.x>0&&output.RequestedSize.y>0?output.RequestedSize:new Vector2Int(640,480));
                output.Input+=Input; output.SizeRequested+=Resize; output.FrameRequested+=Render; output.Closed+=Close;
                lastUpdate=EditorApplication.timeSinceStartup; EditorApplication.update+=Update;
            } catch { Close(); throw; }
        }
        void Resize(Vector2Int size)
        {
            if(closed||size.x<1||size.y<1)return;
            int width=Mathf.Clamp(size.x,1,4096),height=Mathf.Clamp(size.y,1,4096);
            if(target!=null&&target.width==width&&target.height==height)return;
            var old=target;
            target=new RenderTexture(new RenderTextureDescriptor(width,height){graphicsFormat=GraphicsFormat.R8G8B8A8_UNorm,depthBufferBits=24,msaaSamples=1,useMipMap=false,mipCount=1});
            target.Create(); if(old!=null)UnityEngine.Object.DestroyImmediate(old);
        }
        void Input(RenderInput input)
        {
            Inputs++;
            if(input.Kind==RenderInputKind.PointerMove&&(input.Buttons&1)!=0){yaw+=input.Delta.x*180;pitch=Mathf.Clamp(pitch+input.Delta.y*180,-85,85);}
            if(input.Kind==RenderInputKind.Wheel)distance=Mathf.Clamp(distance-input.Delta.y*.3f,1.5f,12);
        }
        void Update()
        {
            double now=EditorApplication.timeSinceStartup;
            if(Playing)Time+=(float)(now-lastUpdate); lastUpdate=now;
            if(Output.IsVisible&&Playing&&now>=nextFrame){nextFrame=now+1.0/120;Render();}
        }
        public void Render()
        {
            if(closed||!Output.IsVisible)return;
            model.localRotation=Quaternion.Euler(0,Time*30,0);
            camera.transform.position=Quaternion.Euler(pitch,yaw,0)*new Vector3(0,0,-distance); camera.transform.LookAt(Vector3.zero);
            if(GraphicsSettings.currentRenderPipeline==null){camera.targetTexture=target;try{camera.Render();}finally{camera.targetTexture=null;}}
            else {
                var request=new RenderPipeline.StandardRequest{destination=target};
                if(!RenderPipeline.SupportsRenderRequest(camera,request))throw new NotSupportedException("Implement this project's render request in RendererExample.cs.");
                RenderPipeline.SubmitRenderRequest(camera,request);
            }
            Output.Publish(target);
        }
        void Close()
        {
            if(closed)return;closed=true;EditorApplication.update-=Update;
            Output.Input-=Input;Output.SizeRequested-=Resize;Output.FrameRequested-=Render;Output.Closed-=Close;
            if(target!=null)UnityEngine.Object.DestroyImmediate(target);
            if(scene.IsValid())EditorSceneManager.ClosePreviewScene(scene);
            if(material!=null)UnityEngine.Object.DestroyImmediate(material);
            Sessions.Remove(Output.Id);
        }
    }
}
