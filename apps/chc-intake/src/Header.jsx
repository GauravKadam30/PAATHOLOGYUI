// src/Header.jsx
export default function Header() {
  return (
    <header className="flex justify-between items-center py-4 px-6 bg-white border-b shadow-sm mb-6 font-sans">
      <h1 className="text-xl font-bold text-blue-900">DEVIPUR CHC: PATIENT INTAKE PORTAL</h1>
      
      <div className="flex items-center gap-3">
        {/* User Icon SVG */}
        <div className="flex items-center gap-2 text-gray-700">
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            className="w-5 h-5" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <span className="text-sm font-semibold">ANJALI DEVI, LAB ATTENDANT</span>
        </div>
        
        {/* Profile Avatar Placeholder */}
        <div className="w-8 h-8 rounded-full bg-blue-100 border border-blue-200 flex items-center justify-center text-blue-700 font-bold text-xs">
          AD
        </div>
      </div>
    </header>
  );
}