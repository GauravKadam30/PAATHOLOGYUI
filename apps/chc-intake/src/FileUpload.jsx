// src/FileUpload.jsx
export default function FileUpload() {
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm h-full font-sans">
      <h2 className="text-lg font-bold text-gray-900 mb-6 border-b pb-2">2. FNAC Slide Image Upload</h2>
      
      {/* Upload Zone */}
      <div className="border-2 border-dashed border-gray-300 p-8 text-center rounded-xl cursor-pointer hover:border-blue-500 transition-colors flex flex-col items-center gap-4 mb-6">
        <div className="bg-blue-50 p-4 rounded-full">
          <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
        </div>
        <p className="text-sm font-bold text-gray-600">CLICK TO UPLOAD OR DRAG & DROP FNAC SLIDE IMAGE</p>
      </div>

      {/* Static Preview Pane */}
      <div className="mb-6 border border-gray-200 rounded-lg p-4 bg-gray-50">
        <p className="text-xs font-bold text-gray-500 uppercase mb-2">Image Preview</p>
        <div className="w-full h-32 bg-gray-200 rounded border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400">
          <span>[No Image Selected]</span>
        </div>
      </div>

      {/* Upload Status Section */}
      <div className="mt-6">
        <div className="flex justify-between text-xs font-semibold text-gray-700 mb-2">
          <span>Upload Status</span>
          <span>0%</span>
        </div>
        <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden border border-gray-300">
          <div className="h-full w-0 transition-all duration-300"></div>
        </div>
        
        <button className="w-full mt-6 bg-blue-900 text-white py-3 rounded-lg font-bold hover:bg-blue-800 transition-all flex items-center justify-center gap-2">
          SUBMIT CASE TO EPTB HUB →
        </button>
      </div>
    </div>
  );
}