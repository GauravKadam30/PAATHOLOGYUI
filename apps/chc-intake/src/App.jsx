// src/App.jsx
import Header from './Header';
import PatientForm from './PatientForm';
import FileUpload from './FileUpload';

// src/App.jsx
function App() {
  return (
    <div className="min-h-screen bg-blue-50"> {/* Removed flex/flex-col here just in case */}
      <Header />
      
      {/* Ensure these classes are present. 
          'w-full' is critical to make it fill the container. */}
      <main className="max-w-7xl mx-auto p-6 grid grid-cols-12 gap-8 w-full">
        <div className="col-span-8">
          <PatientForm />
        </div>
        <div className="col-span-4">
          <FileUpload />
        </div>
      </main>
    </div>
  );
}

export default App;